import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { listedCommand, type VerifyRequest } from "../../src/contracts/control.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import {
  EMPTY_CHAIN, EPHEMERAL_KEY_ID, RELAY_PREF_DEFAULTS, RELAY_PREF_KEYS, RELAY_PREF_VALUES, RELAY_STRICT_PREFS, RelayError, consentSourceOf, defaultAllowCommand, parseBindingRelayState, parseConsentRecord, relayDecisionOf, relayPacketId,
  type BindingRelayState, type BindingSync, type ConsentRecord, type DeliveredMark, type DeliveryRecord, type Fingerprint, type RelayCapabilities, type RelayPacket, type RelayPacketId, type SourceRange, type VendorKey, type VerifyResult,
} from "../../src/contracts/relay.js";
import { SessionError, runId, sessionId, type NativeSessionBinding, type PublicRun, type RunId, type SessionEvent, type SessionSnapshot } from "../../src/contracts/session.js";
import {
  DEFAULT_SETTINGS, STRICT_SETTINGS, UnkeptRelayKeys, RelayLedger, admitRelay, attentionOf, bindingDeliveries, checkedResult, consentGate, consentStanding, decideTurn, decisionRecord, defaultAllowAppend, explicitChoice,
  heldSinceIn, holdsNothing, nativeExactAt, policyAloneOf, relayDeclaration, relaySettings, settleTurn, unavailableResult, verifyRequestOf,
  type Check, type ConsentView, type DecideInput, type RelayChoices, type RelaySettings, type SettleInput,
} from "../../src/contexts/session/application/relay-coordinator.js";
import { chainAfter, owed, planReturnVerify, step, type BindingDelivery, type RelayFact, type VerifyPlan } from "../../src/contexts/session/domain/relay/delivery.js";
import { parseSession } from "../../src/contexts/session/domain/state.js";

// G068 phase two, fix batch after the review of db39cbd (R7): the relay coordinator's pure hooks — admission's synchronous
// 409, the choice between b, n and a, the settlement written with run.ended, a Driver's check answer read defensively — and the
// read path's rules the review named (A6: a Run without relay or index row is foreign until a packet covers it; A10: only an
// epoch's latest 32 recorded rows keep a mark a check may fall back to). Each case is an input written by hand and the output
// the coordinator must give; nothing here runs a Runtime, a Store or a Driver.

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex") as Fingerprint;
const packet = (digit: string): RelayPacketId => relayPacketId("relay-" + digit.repeat(20));
const P1 = packet("1"), P2 = packet("2");
const R1 = runId("run-one"), R2 = runId("run-two"), R3 = runId("run-three"), NOW = runId("run-now");
const RANGE1: SourceRange = { fromSeq: 3, throughSeq: 6, fromRun: 0, throughRun: 1 }, RANGE2: SourceRange = { fromSeq: 7, throughSeq: 9, fromRun: 2, throughRun: 3 };
const SHA1 = sha("packet one"), SHA2 = sha("packet two");
const MARK1: DeliveredMark = { throughSeq: 6, chain: chainAfter(null, SHA1), lastPacketId: P1, evidence: "E3", basis: "evidence" };
const NO_CACHE = { lastRequestStartedAt: null, contextUsed: null, contextSize: null };
const X = { harnessId: "xray", controlId: "xray-acp" } as const;
function relay(sync: BindingSync, extra: Partial<BindingRelayState> = {}): BindingRelayState {
  return parseBindingRelayState({ nativeEpoch: 1, sync, originIncluded: false, reanchor: false, packetsInEpoch: 1, epochFloor: -1, compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved: null, cache: NO_CACHE, ...extra });
}
const FRESH = relay({ kind: "fresh", basis: "new" }, { packetsInEpoch: 0 });
const SYNCED = relay({ kind: "synced", mark: MARK1 });
const pending = (autoResends: 0 | 1, attachOverride = false) => relay({ kind: "pending", prior: { kind: "synced", mark: MARK1 }, packetId: P2, range: RANGE2, autoResends, manualResends: 0, attachOverride });
/** Facts of another Harness at seqs 3, 6, 7 and 9 (P1 covers 3 and 6, P2 7 and 9). */
const FOREIGN: readonly RelayFact[] = [3, 6, 7, 9].map(seq => ({ runId: runId("run-y" + seq), seq, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }));
function caps(overrides: { readonly verify?: RelayCapabilities["delivery"]["verify"]; readonly lateDelivery?: boolean; readonly successProvesRecorded?: boolean } = {}): RelayCapabilities {
  return { ...dshRelayCapabilities, commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: text => listedCommand(text, null) },
    delivery: { live: "none", verify: overrides.verify ?? "none", successProvesRecorded: overrides.successProvesRecorded ?? false, lateDelivery: overrides.lateDelivery ?? false } };
}
/** A declaration whose reading of a slash word is a definite command (a Driver that settles it without a catalog). */
const COMMANDING: RelayCapabilities = { ...caps(), commands: { ...caps().commands, classify: text => text.startsWith("/") ? { kind: "command", name: text.slice(1), args: "", effect: "compact" } : { kind: "content" } } };
const binding = (state: BindingRelayState, extra: Partial<NativeSessionBinding> = {}): NativeSessionBinding => ({ ...X, checkpoint: "native-x", throughRunId: null, status: "ready", relay: state, ...extra });
function snapshot(bindings: readonly NativeSessionBinding[], extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { schemaVersion: 13, id: sessionId("session-unit"), version: 1, lastSeq: 20, epoch: 1, status: "open", configuration: { workspace: "/w", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    selection: X, activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [], nativeBindings: bindings, ...extra } as SessionSnapshot;
}
/** admitRelay's verdict: "ok", or the relay error's code{reason}. */
function admit(state: BindingRelayState, choices: RelayChoices = {}, options: { readonly capabilities?: RelayCapabilities | null | undefined; readonly text?: string; readonly facts?: readonly RelayFact[]; readonly extra?: Partial<SessionSnapshot> } = {}): string {
  const bound = binding(state), at = snapshot([bound], options.extra);
  try {
    admitRelay({ state: at, binding: bound, target: X, capabilities: "capabilities" in options ? options.capabilities : caps(), text: options.text ?? "hello", attachments: [], choices, facts: () => options.facts ?? FOREIGN });
    return "ok";
  } catch (error) {
    if (error instanceof RelayError) return error.code + "{" + error.reason + "}";
    if (error instanceof SessionError) return error.code;
    throw error;
  }
}

test("G068 fix R7 admitRelay: only an input that would carry relay content is asked; a pending packet whose resend is spent asks unless the user resends (resend or attach full, R9b); a suspect binding no check can settle asks", () => {
  assert.equal(admit(SYNCED, {}, { facts: [] }), "ok", "a single-Harness conversation is never asked");
  assert.equal(admit(pending(1), { attach: "none" }), "ok", "an input sent alone is never asked");
  assert.equal(admit(pending(1), {}, { text: "/compact", capabilities: COMMANDING }), "ok", "a command carries nothing");
  assert.equal(admit(pending(1), {}, { text: "/compact" }), "ok", "a word only the catalog settles is not asked either: the open's checks decide it");
  assert.equal(admit(pending(1), {}, { capabilities: undefined }), "ok", "a factory that cannot tell the declaration leaves it to the open");
  assert.equal(admit(pending(0)), "ok", "the one automatic resend");
  assert.equal(admit(pending(1)), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  assert.equal(admit(pending(0), {}, { capabilities: caps({ lateDelivery: true }) }), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}", "lateDelivery never resends by itself");
  assert.equal(admit(pending(1), {}, { capabilities: caps({ verify: "on_next_open" }) }), "ok", "a Driver that checks at the open decides there");
  assert.equal(admit(pending(1), { resend: true }), "ok");
  assert.equal(admit(pending(1), { attach: "full" }), "ok", "R9b: attach full on a pending packet is the user's resend");
  assert.equal(admit(pending(0), {}, { extra: { relayRecoveryFailed: 3 } }), "RELAY_UNAVAILABLE{recovery_failed}");
  // Suspect: a packet mark nothing can check needs the user; with a check at the open it is let through.
  const rewound = relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null, rewound: false });
  assert.equal(admit(rewound), "RELAY_CHOICE_REQUIRED{verify_required}");
  assert.equal(admit(rewound, {}, { capabilities: caps({ verify: "on_next_open" }) }), "ok");
  assert.equal(admit(rewound, { attach: "full" }), "ok", "the user's complete packet");
  for (const cause of ["legacy", "marker_absent"] as const) {
    const state = relay({ kind: "suspect", mark: MARK1, cause, floorCandidate: null, carried: null, rewound: false });
    assert.equal(admit(state), "RELAY_CHOICE_REQUIRED{" + (cause === "legacy" ? "verify_required" : "marker_absent") + "}", cause + " owing");
    assert.equal(admit(state, {}, { facts: FOREIGN.slice(0, 2) }), "ok", cause + " owing nothing: b passes it");
  }
  // R9a: a carried packet a Driver without a check sends back to pending with its automatic resend spent: asked now.
  const carried = relay({ kind: "suspect", mark: null, cause: "rewind", floorCandidate: null, carried: { prior: { kind: "fresh", basis: "new" }, packetId: P2, range: RANGE2, attachOverride: false }, rewound: false });
  assert.equal(admit(carried), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  assert.equal(admit(carried, { attach: "full" }), "ok"); assert.equal(admit(carried, { resend: true }), "ok");
  assert.equal(admit(carried, {}, { capabilities: caps({ verify: "on_next_open" }) }), "ok", "a check at the open may still find the packet");
});

const DECLARED = relayDeclaration(caps());
function decide(state: BindingRelayState, choices: RelayChoices = {}, extra: Partial<DecideInput> = {}) {
  return decideTurn({ relay: state, ...X, facts: FOREIGN, originHistory: false, choices, declaration: DECLARED, firstFromSeq: 3, pendingRun: R2, recoveryFailed: false, ...extra });
}
function refused(run: () => unknown): string {
  try { run(); return "no error"; } catch (error) { if (error instanceof RelayError) return error.code + "{" + error.reason + "}"; throw error; }
}

test("G068 fix R7 decideTurn: b as typed when nothing is owed, n when the user sends it alone, a packet of what is owed; a pending packet resent once by itself, then only on the user's resend or attach full (R9b); a suspect one only on the user's complete packet, as typed when its retreated prior owes nothing (R5)", () => {
  assert.deepEqual(decide(SYNCED, {}, { facts: FOREIGN.slice(0, 2) }), { kind: "plain", foreign: true, nothingToAttach: false });
  assert.deepEqual(decide(SYNCED, { attach: "full" }, { facts: FOREIGN.slice(0, 2) }), { kind: "plain", foreign: true, nothingToAttach: true }, "A9: asked for the history, nothing to attach");
  assert.deepEqual(decide(SYNCED, { attach: "none" }), { kind: "alone", by: "user" });
  const carry = decide(SYNCED);
  assert.ok(carry.kind === "carry" && carry.resend === null && carry.need.facts.map(fact => fact.seq).join() === "7,9");
  const auto = decide(pending(0));
  assert.ok(auto.kind === "carry" && auto.resend?.by === "auto" && auto.resend.of === R2 && auto.need.facts.map(fact => fact.seq).join() === "7,9");
  assert.equal(refused(() => decide(pending(1))), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  for (const choices of [{ resend: true as const }, { attach: "full" as const }]) {
    const user = decide(pending(1), choices);
    assert.ok(user.kind === "carry" && user.resend?.by === "user", JSON.stringify(choices));
  }
  assert.equal(refused(() => decide(pending(0), {}, { pendingRun: null })), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}", "a resend names what it supersedes");
  assert.equal(refused(() => decide(pending(0), {}, { recoveryFailed: true })), "RELAY_UNAVAILABLE{recovery_failed}");
  // A7 point 4 (G072): nothing owed on a pending packet goes back to its prior, as typed, nobody asked.
  assert.deepEqual(decide(pending(0), {}, { facts: FOREIGN.slice(0, 2) }), { kind: "plain", foreign: true, nothingToAttach: false, owedNothing: true }, "nothing owed on a pending packet");
  // Suspect: as typed only with nothing foreign at all; otherwise the user's choice, which retreats to the epoch base.
  const rewound = relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null, rewound: false });
  assert.equal(refused(() => decide(rewound)), "RELAY_CHOICE_REQUIRED{verify_required}");
  assert.deepEqual(decide(rewound, {}, { facts: [] }), { kind: "plain", foreign: false, nothingToAttach: false });
  const retreat = decide(rewound, { attach: "full" });
  assert.ok(retreat.kind === "carry" && retreat.retreat?.firstFromSeq === 3 && retreat.need.facts.map(fact => fact.seq).join() === "3,6,7,9", "the complete packet from the epoch base");
  // R5: the reviewer's I1 — the mark at the clear floor on a packet attached once, its facts all below the floor: nothing is
  // owed on the retreated prior, so the user's choice goes as typed and the binding stands there.
  const atFloor: DeliveredMark = { throughSeq: 10, chain: chainAfter(null, SHA1), lastPacketId: P1, evidence: "E3", basis: "evidence" };
  const stuck = relay({ kind: "suspect", mark: atFloor, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, { nativeEpoch: 2, epochFloor: 10 });
  const older: readonly RelayFact[] = [{ runId: R1, seq: 4, executedOn: { ...X, nativeEpoch: 1 } }];
  assert.equal(refused(() => decide(stuck, {}, { facts: older })), "RELAY_CHOICE_REQUIRED{verify_required}");
  for (const choices of [{ attach: "full" as const }, { resend: true as const }]) {
    const typed = decide(stuck, choices, { facts: older, firstFromSeq: 4 });
    assert.deepEqual(typed, { kind: "plain", foreign: true, nothingToAttach: true, retreat: { firstFromSeq: 4 } }, JSON.stringify(choices));
    const stood = step(stuck, { kind: "plain", foreign: true, retreat: { firstFromSeq: 4 } });
    assert.ok(stood.kind === "applied" && stood.relay.sync.kind === "synced" && stood.relay.sync.mark.throughSeq === 10 && stood.relay.sync.mark.lastPacketId === null && stood.relay.sync.mark.evidence === "choice" && stood.note.verified === "nothing_owed");
  }
  // A legacy mark below the epoch base stays on the choice and does not come back: still the user's.
  const legacy = relay({ kind: "suspect", mark: { throughSeq: 10, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "legacy", basis: "legacy" }, cause: "legacy", floorCandidate: null, carried: null, rewound: false }, { nativeEpoch: 2, epochFloor: 10 });
  assert.equal(refused(() => decide(legacy, { attach: "full" }, { facts: older, firstFromSeq: 20 })), "RELAY_CHOICE_REQUIRED{verify_required}");
});

test("G068 fix R1 decideTurn and owed: after a clear confirmed in place, the binding's own Turns since the clear (the previous epoch, above the floor) are no foreign facts; after a new native session they are", () => {
  // Epoch 2 rose in place on a clear at seq 12; Turns at 14 and 16 ran on this native session before it was confirmed.
  const cleared = relay({ kind: "fresh", basis: "user_cleared" }, { nativeEpoch: 2, epochFloor: 12, packetsInEpoch: 0 });
  const own: readonly RelayFact[] = [10, 14, 16].map(seq => ({ runId: runId("run-own" + seq), seq, executedOn: { ...X, nativeEpoch: 1 } }));
  const inPlace = snapshot([binding(cleared)]), afterReset = snapshot([binding(relay({ kind: "fresh", basis: "new" }), { status: "archived" }), binding(cleared)]);
  assert.equal(heldSinceIn(inPlace, X.harnessId, X.controlId, cleared), 1, "its native session held epoch 1 too");
  assert.equal(heldSinceIn(afterReset, X.harnessId, X.controlId, cleared), 2, "epoch 1 was an archived native session's");
  const seqs = (since: number, attachOverride = false) => owed(cleared, X.harnessId, X.controlId, own, { originHistory: false, heldSince: since, attachOverride }).facts.map(fact => fact.seq);
  assert.deepEqual(seqs(1), [], "the Turns since the clear are in the history it left");
  assert.deepEqual(seqs(1, true), [10], "attach once brings back what the clear removed, not what came after it");
  assert.deepEqual(seqs(2), [14, 16], "a new native session holds none of them");
  assert.deepEqual(owed(cleared, X.harnessId, X.controlId, own, { originHistory: false }).facts.map(fact => fact.seq), [14, 16], "without heldSince: the conservative reading");
  assert.deepEqual(decideTurn({ relay: cleared, ...X, facts: own, originHistory: false, choices: {}, declaration: DECLARED, firstFromSeq: null, pendingRun: null, recoveryFailed: false, heldSince: 1 }), { kind: "plain", foreign: true, nothingToAttach: false });
});

/** A settlement of `turn` on `state`, at run.ended seq 30. */
function settle(state: BindingRelayState, turn: SettleInput["turn"], extra: Partial<SettleInput> = {}) {
  return settleTurn({ relay: state, runId: R3, openCheck: null, turn, dispatched: true, status: "completed", input: undefined, noop: false, cleared: null, declaration: DECLARED,
    settledCheck: null, unknownTurn: false, endedSeq: 30, time: 300, ...extra });
}
const carried = (extra: Partial<Extract<SettleInput["turn"], { kind: "carry" }>> = {}): SettleInput["turn"] => ({ kind: "carry", runId: R3, packetId: P2, range: RANGE2, bodySha256: SHA2, reanchored: false, recorded: false, superseded: null, resent: false, ...extra });
const pendingOnP2 = () => step(SYNCED, { kind: "carry", runId: R3, packet: { id: P2, range: RANGE2 }, attachOverride: false, lateDelivery: false, resend: null });

test("G068 fix R7 settleTurn: g/h/i by evidence alone, j for b, n changes nothing, a command's effect when it ran, a Driver-confirmed clear is e whatever the Turn (R10d), Claude's replacement; checks are committed after run.ended", () => {
  const onP2 = pendingOnP2();
  assert.ok(onP2.kind === "applied");
  const recorded = settle(onP2.relay, carried(), { input: "recorded" });
  assert.equal(recorded.relay.sync.kind, "synced"); assert.deepEqual(recorded.delivery, { packetId: P2, outcome: "recorded", evidence: "E3", mark: recorded.relay.sync.kind === "synced" ? recorded.relay.sync.mark : null });
  assert.deepEqual(recorded.deliveries, [{ kind: "outcome", runId: R3, outcome: { kind: "recorded", evidence: "E3", decidedSeq: 30, decidedAt: 300, verifiedInRun: null } }]);
  const refusedFirst = settle(onP2.relay, carried(), { input: "not_recorded" });
  assert.deepEqual(refusedFirst.relay.sync, SYNCED.sync, "a first packet known not there: back to its prior");
  const unknown = settle(onP2.relay, carried());
  assert.equal(unknown.relay.sync.kind, "pending"); assert.equal(unknown.delivery?.outcome, "unknown");
  // A resend refused without the packet it superseded to go back to stays unknown, never not recorded.
  const resent = step(onP2.relay, { kind: "carry", runId: R1, packet: { id: P1, range: RANGE1 }, attachOverride: false, lateDelivery: false, resend: { by: "auto", of: R3 } });
  assert.ok(resent.kind === "applied");
  assert.equal(settle(resent.relay, carried({ runId: R1, packetId: P1, range: RANGE1, bodySha256: SHA1, resent: true }), { runId: R1, input: "not_recorded" }).delivery?.outcome, "unknown");
  const back = settle(resent.relay, carried({ runId: R1, packetId: P1, range: RANGE1, bodySha256: SHA1, resent: true, superseded: { packetId: P2, range: RANGE2 } }), { runId: R1, input: "not_recorded" });
  assert.ok(back.relay.sync.kind === "pending" && back.relay.sync.packetId === P2 && back.relay.sync.autoResends === 1, "back to waiting for the packet it superseded");
  // E1 decided it before the end: the settlement finds it recorded and changes nothing.
  const e1 = step(onP2.relay, { kind: "carry_settled", runId: R3, packetId: P2, bodySha256: SHA2, reanchored: false, row: "in_flight", outcome: { kind: "recorded", evidence: "E1", decidedSeq: 25, decidedAt: 250, verifiedInRun: null } });
  assert.ok(e1.kind === "applied");
  const after = settle(e1.relay, carried({ recorded: true }));
  assert.deepEqual(after.relay, e1.relay); assert.deepEqual(after.deliveries, []); assert.deepEqual(after.delivery, { packetId: P2, outcome: "recorded", evidence: "E1", mark: null });
  // j, n.
  assert.deepEqual(settle(FRESH, { kind: "plain", contextThroughSeq: 18, agentOutput: true, recorded: false }).relay.sync, { kind: "synced", mark: { throughSeq: 18, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "native", basis: "native" } });
  assert.equal(settle(SYNCED, { kind: "plain", contextThroughSeq: 18, agentOutput: false, recorded: false }, { input: "not_recorded" }).shown, "not_sent");
  assert.deepEqual(settle(pending(1), { kind: "alone" }).relay, pending(1));
  // Commands: the declared effect only when it ran; a clear the Driver confirmed is e, one it could not is e′.
  assert.equal(settle(SYNCED, { kind: "command", declared: "clear" }).relay.sync.kind, "suspect");
  assert.equal(settle(SYNCED, { kind: "command", declared: "clear" }, { input: "not_recorded" }).relay.sync.kind, "synced", "it never ran");
  const confirmed = settle(SYNCED, { kind: "command", declared: "clear" }, { status: "failed", cleared: { replaced: false } });
  assert.deepEqual(confirmed.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(confirmed.relay.epochFloor, 30);
  const replaced = settle(SYNCED, { kind: "command", declared: "clear" }, { cleared: { replaced: true }, input: "not_recorded" });
  assert.equal(replaced.replaced, true); assert.equal(replaced.relay.nativeEpoch, 2); assert.deepEqual(replaced.binding, { before: "synced", after: "fresh", nativeEpoch: 2, epochFloor: 30, packetsInEpoch: 0, replaced: true });
  // R10d: a content Turn the Driver reports cleared, a carrying one included (on pending: the packet's delivery is no longer pursued).
  const plainCleared = settle(SYNCED, { kind: "plain", contextThroughSeq: 18, agentOutput: true, recorded: false }, { cleared: { replaced: false } });
  assert.deepEqual(plainCleared.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(plainCleared.relay.nativeEpoch, 2);
  const carryCleared = settle(onP2.relay, carried(), { cleared: { replaced: false } });
  assert.deepEqual(carryCleared.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(carryCleared.delivery?.outcome, "unknown", "its row is decided first");
  assert.equal(settle(onP2.relay, carried(), { cleared: { replaced: false }, dispatched: false }).relay.sync.kind, "synced", "nothing dispatched clears nothing");
  // A check that was not committed before the Turn failed, and after_turn's, go with the end; their seqs follow run.ended's.
  const rows: readonly BindingDelivery[] = [{ record: deliveryRecord(R3, P2, "unknown"), nativeEpoch: 1, range: RANGE2, bodySha256: SHA2, reanchor: false, mark: null }];
  const plan = planReturnVerify(unknown.relay, { verify: "after_turn", moment: "settled", deliveries: rows });
  const check: Check = { plan, result: { markers: [{ packetId: P2, result: "present" }], historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 2 }, moment: "settled" };
  const checkedEnd = settle(onP2.relay, carried(), { settledCheck: check });
  assert.equal(checkedEnd.relay.sync.kind, "synced"); assert.equal(checkedEnd.events.length, 1); assert.equal(checkedEnd.events[0]!.type, "relay.verified");
  assert.equal(checkedEnd.events[0]!.data.result, "recorded"); assert.equal(checkedEnd.events[0]!.data.moment, "settled");
  assert.deepEqual(checkedEnd.deliveries.at(-1), { kind: "outcome", runId: R3, outcome: { kind: "recorded", evidence: "E2", decidedSeq: 31, decidedAt: 300, verifiedInRun: R3 } });
  const skipped: Check = { plan: { kind: "skip", reason: "decided" }, result: unavailableResult(null), moment: "settled" };
  assert.deepEqual(settle(SYNCED, { kind: "plain", contextThroughSeq: 18, agentOutput: true, recorded: false }, { settledCheck: skipped }).events, [], "a check that looked for nothing and changed nothing adds no event");
});

function deliveryRecord(run: RunId, packetId: RelayPacketId, outcome: "recorded" | "unknown"): DeliveryRecord {
  return { runId: run, packetId, channel: "text_block", position: { kind: "seq", before: 4 },
    outcome: outcome === "recorded" ? { kind: "recorded", evidence: "E3", decidedSeq: 5, decidedAt: 5, verifiedInRun: null } : { kind: "unknown", reason: "no_evidence", decidedSeq: 5, decidedAt: 5 },
    consentLogSeq: null, inputHmac: "c".repeat(64) as DeliveryRecord["inputHmac"], redaction: { rulesVersion: "egress/1", keyId: EPHEMERAL_KEY_ID, setHmac: "0a1b2c3d" as DeliveryRecord["redaction"]["setHmac"] },
    compactionAtDelivery: null, resendOf: null, attachOverride: false, verifyMs: null, realized: null };
}

test("G068 fix R7 checkedResult and verifyRequestOf: a Driver's answer is read defensively — an unknown marker value, a marker not asked or not answered is unavailable; a history or cursor that is not one is none; each packet asked once", () => {
  const request: VerifyRequest = { markers: [{ packetId: P1, position: { kind: "seq", before: 4 } }, { packetId: P2, position: { kind: "seq", before: 8 } }], historyEmpty: true };
  // M19: a value outside MARKER_RESULTS is never taken for an answer.
  assert.deepEqual(checkedResult({ markers: [{ packetId: P1, result: "yes" }, { packetId: P2, result: "present" }] }, request).markers, [{ packetId: P1, result: "unavailable" }, { packetId: P2, result: "present" }]);
  assert.deepEqual(checkedResult({ markers: [{ packetId: packet("9"), result: "present" }] }, request).markers.map(marker => marker.result), ["unavailable", "unavailable"], "an answer for a packet not asked counts for nothing");
  for (const raw of [null, undefined, "garbage", 7, [], { markers: "garbage" }, { markers: [null, 3, { packetId: P1 }] }]) {
    const read = checkedResult(raw, request);
    assert.deepEqual(read.markers.map(marker => marker.result), ["unavailable", "unavailable"], JSON.stringify(raw) ?? "undefined");
    assert.equal(read.historyEmpty, null); assert.equal(read.compaction, null); assert.equal(read.verifyMs, 0);
  }
  const odd = checkedResult({ markers: [], historyEmpty: "yes", compaction: { count: -1, digest: null }, foreignAfterLast: 1.5, verifyMs: -3 }, request);
  assert.equal(odd.historyEmpty, null); assert.equal(odd.compaction, null); assert.equal(odd.foreignAfterLast, null); assert.equal(odd.verifyMs, 0);
  assert.equal(checkedResult({ markers: [], compaction: { count: 1, digest: "not a digest" } }, request).compaction, null);
  const good = checkedResult({ markers: [{ packetId: P2, result: "compacted" }], historyEmpty: false, compaction: { count: 2, digest: SHA1 }, foreignAfterLast: 3, verifyMs: 9 }, request);
  assert.deepEqual(good, { markers: [{ packetId: P1, result: "unavailable" }, { packetId: P2, result: "compacted" }], historyEmpty: false, compaction: { count: 2, digest: SHA1 }, foreignAfterLast: 3, verifyMs: 9 });
  // The same packet in a plan twice (its newest row only) is asked once; a skip asks nothing.
  const planned = (packetId: RelayPacketId, run: RunId) => ({ runId: run, packetId, position: { kind: "seq" as const, before: 4 }, compactionAtDelivery: null, range: RANGE1, bodySha256: SHA1, reanchor: false, mark: null, row: "unknown" as const });
  const plan: VerifyPlan = { kind: "pending", marker: planned(P1, R2), earlier: [planned(P1, R1), planned(P2, R3)] };
  assert.deepEqual(verifyRequestOf(plan)?.markers.map(marker => marker.packetId), [P2, P1]);
  assert.equal(verifyRequestOf({ kind: "skip", reason: "unavailable" }), null);
  assert.deepEqual(verifyRequestOf({ kind: "clear", chain: [], carried: null, firstFromSeq: null }), { markers: [], historyEmpty: true }, "an unconfirmed clear asks whether the history is empty even with no marker (rule 1)");
  assert.equal(verifyRequestOf({ kind: "suspect", markers: [], carried: null, firstFromSeq: null }), null);
  assert.deepEqual(unavailableResult(null).markers, []);
});

/** A Session of two Runs on yankee and one on xray; `relayOf` gives each Run's relay (or none). */
function factsState(relayOf: (index: number) => PublicRun["relay"]): SessionSnapshot {
  const runs = [0, 1, 2].map(index => ({ id: runId("run-" + index), commandId: "send-" + index, input: "input " + index, userMessageId: "message-" + index, assistantMessageId: "reply-" + index,
    selection: index === 2 ? X : { harnessId: "yankee", controlId: "yankee-acp" }, epoch: 1, status: "completed", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: { status: "completed", reason: "fake" },
    cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null, timing: { acceptedAt: 1, dispatchedAt: 2 }, ...(relayOf(index) === undefined ? {} : { relay: relayOf(index) }) }));
  return snapshot([], { runs, lastSeq: 12 } as unknown as Partial<SessionSnapshot>);
}
const ENDED: readonly SessionEvent[] = [0, 1, 2].map(index => ({ type: "run.ended", data: { runId: "run-" + index }, seq: 4 * (index + 1), sessionId: sessionId("session-unit"), ownerGeneration: 1, occurredAt: "2026-11-10T00:00:00Z" } as unknown as SessionEvent));

test("G068 fix R10e A6: a Run without relay and without an index row is foreign to every binding (it may be sent again, never lost) until a recorded packet covers it", () => {
  const state = factsState(index => index === 0 ? undefined : { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...(index === 2 ? X : { harnessId: "yankee", controlId: "yankee-acp" }), nativeEpoch: 1 } });
  let reads = 0;
  const ledger = new RelayLedger((_id, after) => { reads++; return ENDED.filter(event => event.seq > after); });
  const facts = ledger.facts(state, [], { ...X, nativeEpoch: 1 });
  assert.deepEqual(facts.map(fact => [fact.runId, fact.seq, fact.executedOn]), [["run-0", 4, null], ["run-1", 8, { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 }]], "xray's own Turn is no fact to it; the Run without relay is foreign");
  assert.ok(reads > 0);
  assert.deepEqual(ledger.facts(state, [], { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 }).map(fact => fact.runId), ["run-0", "run-2"], "foreign to yankee too, where it may have run");
  assert.deepEqual(owed(FRESH, X.harnessId, X.controlId, facts, { originHistory: false }).facts.map(fact => fact.runId), ["run-0", "run-1"]);
  const covering = relay({ kind: "synced", mark: { throughSeq: 8, chain: chainAfter(null, SHA1), lastPacketId: P1, evidence: "E3", basis: "evidence" } });
  assert.deepEqual(owed(covering, X.harnessId, X.controlId, facts, { originHistory: false }).facts, [], "covered by the recorded packet: no longer owed");
  // A single-Harness conversation reads no event for its facts.
  const single = factsState(index => ({ packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...X, nativeEpoch: 1 } }));
  reads = 0;
  assert.deepEqual(new RelayLedger(() => { reads++; return []; }).facts(single, [], { ...X, nativeEpoch: 1 }), []); assert.equal(reads, 0);
});

test("G068 fix R10e A10: only an epoch's latest 32 recorded rows keep the mark their recording made; an older row a check finds is never a mark to fall back to, so the binding retreats (or the user decides), never advances on it", () => {
  const bodies = Array.from({ length: 34 }, (_, index) => sha("packet " + index));
  const ids = Array.from({ length: 34 }, (_, index) => relayPacketId("relay-" + String(index).padStart(2, "0").repeat(10)));
  const marks: DeliveredMark[] = [];
  for (let index = 0; index < 34; index++) marks.push({ throughSeq: 10 + index, chain: chainAfter(marks[index - 1]?.chain ?? null, bodies[index]!), lastPacketId: ids[index]!, evidence: "E3", basis: "evidence" });
  const rows = ids.map((id, index) => ({ ...deliveryRecord(runId("run-p" + index), id, "recorded"), outcome: { kind: "recorded" as const, evidence: "E3" as const, decidedSeq: 100 + index, decidedAt: 1, verifiedInRun: null } }));
  const packets: RelayPacket[] = ids.map((id, index) => ({ id, body: { sha256: bodies[index]! }, reanchor: false, range: { fromSeq: 10 + index, throughSeq: 10 + index, fromRun: index, throughRun: index }, target: { ...X, model: null, vendor: "unknown:xray", nativeEpoch: 1 } }) as unknown as RelayPacket);
  const suspectState = relay({ kind: "suspect", mark: marks[33]!, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, { packetsInEpoch: 34 });
  const state = snapshot([binding(suspectState)]);
  const delivered = bindingDeliveries(state, state.nativeBindings![0]!, rows, packets, (seq, run) => marks[Number(String(run).slice(5))] ?? (seq < 0 ? null : null));
  assert.equal(delivered.length, 34);
  assert.deepEqual(delivered.map(row => row.mark === null), [true, true, ...Array<boolean>(32).fill(false)], "the 33rd and older rows keep no mark");
  const plan = planReturnVerify(suspectState, { verify: "on_next_open", moment: "open", deliveries: delivered });
  assert.ok(plan.kind === "suspect" && plan.markers.every(marker => marker.mark !== null) && !plan.markers.some(marker => marker.packetId === ids[0] || marker.packetId === ids[1]), "a check looks only at rows that keep their mark");
  // The checked markers all gone (only the oldest rows would still be there): the epoch base, never a mark of an old row.
  const result: VerifyResult = { markers: (plan.kind === "suspect" ? plan.markers : []).map(marker => ({ packetId: marker.packetId, result: "absent" as const })), historyEmpty: false, compaction: null, foreignAfterLast: null, verifyMs: 1 };
  const outcome = step(suspectState, { kind: "verified", plan, result, inRunId: NOW, at: { seq: 200, time: 1 } });
  assert.ok(outcome.kind === "applied" && outcome.relay.sync.kind === "synced" && outcome.relay.sync.mark.lastPacketId === null && outcome.relay.sync.mark.throughSeq === 9, JSON.stringify(outcome));
  // A binding synced on an old row's packet: its own marker is still checked (present keeps, absent is marker_absent), never a fall back.
  const onOld = relay({ kind: "synced", mark: marks[0]! });
  const oldPlan = planReturnVerify(onOld, { verify: "on_next_open", moment: "open", deliveries: delivered });
  assert.equal(oldPlan.kind, "synced");
  const absent = step(onOld, { kind: "verified", plan: oldPlan, result: { ...result, markers: [{ packetId: ids[0]!, result: "absent" }] }, inRunId: NOW, at: { seq: 200, time: 1 } });
  assert.ok(absent.kind === "applied" && absent.relay.sync.kind === "suspect" && absent.relay.sync.cause === "marker_absent");
});

test("G068 fix R10g the keyed digests of delivery rows made under an owner's ephemeral key name the reserved key identity (G072: only a Runtime composed without the installation key uses one)", () => {
  const keys = new UnkeptRelayKeys();
  assert.equal(EPHEMERAL_KEY_ID, "ephemeral"); assert.equal(keys.keyId, EPHEMERAL_KEY_ID);
  assert.notEqual(keys.inputHmac(sessionId("session-a"), "words"), new UnkeptRelayKeys().inputHmac(sessionId("session-a"), "words"), "a key per owner, never kept");
  assert.notEqual(keys.inputHmac(sessionId("session-a"), "words"), keys.inputHmac(sessionId("session-b"), "words"), "a subkey per Session");
});

test("G068 fix R10a (A1) a binding without relay state, the one case exactAt reads as never exact, cannot exist in a v13 Session: the parser refuses it", () => {
  const valid = { ...snapshot([binding(SYNCED)]), commands: [{ id: "create-unit", kind: "create", fingerprint: "a".repeat(64), resultId: "session-unit" }], lastSeq: 1 };
  assert.doesNotThrow(() => parseSession(valid));
  const { relay: _dropped, ...bare } = binding(SYNCED);
  assert.throws(() => parseSession({ ...valid, nativeBindings: [bare] }), /every v13 native binding has its relay state/u);
});

test("G068 fix2 M-1 admitRelay and ［确认已清空］: offered only on an unconfirmed clear whose check is undecided; one the open would settle without the user gets that landing's 409 or is refused (INVALID_INPUT), never let through to be dropped", () => {
  const clear = (mark: DeliveredMark | null, carried: boolean) => relay({ kind: "suspect", mark, cause: "clear_unconfirmed", floorCandidate: 12, carried: carried ? { prior: { kind: "fresh", basis: "new" }, packetId: P2, range: RANGE2, attachOverride: false } : null, rewound: false });
  // The reviewer's case: no check, a carried packet whose prior comes back → the open sends it back to pending with its resend spent.
  assert.equal(admit(clear(null, true), { clearConfirmed: true }), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  // A mark that comes back by itself (none, here): the open restores it whether or not anything is owed.
  assert.equal(admit(clear(null, false), { clearConfirmed: true }, { facts: [] }), "INVALID_INPUT", "a single Harness: not offered");
  assert.equal(admit(clear(null, false), { clearConfirmed: true }), "INVALID_INPUT", "with facts owed: not offered either");
  // A packet mark no check can look at: the table leaves it suspect, which is where the user's confirmation is offered.
  assert.equal(admit(clear(MARK1, false), { clearConfirmed: true }), "ok");
  // A Driver that checks at the open: the check decides, and the Run fails before dispatch if it decided otherwise.
  assert.equal(admit(clear(null, true), { clearConfirmed: true }, { capabilities: caps({ verify: "on_next_open" }) }), "ok");
  assert.equal(admit(clear(MARK1, false), { clearConfirmed: true }, { capabilities: caps({ verify: "on_next_open" }) }), "ok");
  // Not an unconfirmed clear at all.
  assert.equal(admit(SYNCED, { clearConfirmed: true }), "INVALID_INPUT");
  assert.equal(admit(SYNCED, { clearConfirmed: true }, { facts: [] }), "INVALID_INPUT");
  assert.equal(admit(pending(0), { clearConfirmed: true }), "INVALID_INPUT");
  assert.equal(admit(relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null, rewound: false }), { clearConfirmed: true }), "INVALID_INPUT");
  // What admission never asks about stays so: a command carries nothing, a factory that cannot tell leaves it to the open.
  assert.equal(admit(SYNCED, { clearConfirmed: true }, { text: "/compact", capabilities: COMMANDING }), "ok");
  assert.equal(admit(SYNCED, { clearConfirmed: true }, { text: "/compact" }), "ok");
  assert.equal(admit(SYNCED, { clearConfirmed: true }, { capabilities: undefined }), "ok");
});

test("G068 fix2 R10a nativeExactAt: a binding without relay state is never exact (the branch is unreachable in a v13 Session, and pinned here); a synced one is exact at a Turn of its epoch with nothing foreign owed up to it", () => {
  const through = { id: R2, relay: { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...X, nativeEpoch: 1 } } } as unknown as PublicRun;
  const state = snapshot([binding(SYNCED)]), none = () => [], at = (seq: number | undefined) => () => seq;
  const { relay: _dropped, ...bare } = binding(SYNCED);
  assert.equal(nativeExactAt(state, bare as NativeSessionBinding, through, at(10), none), false, "no relay state: nothing says what the native session holds");
  assert.equal(nativeExactAt(state, binding(SYNCED), through, at(10), none), true);
  assert.equal(nativeExactAt(state, binding(SYNCED), through, at(undefined), none), false, "a Turn whose end the events do not place");
  assert.equal(nativeExactAt(state, binding(pending(0)), through, at(10), none), false, "only a synced binding");
  assert.equal(nativeExactAt(state, binding(relay({ kind: "synced", mark: MARK1 }, { nativeEpoch: 2 })), through, at(10), none), false, "a Turn of another epoch");
  assert.equal(nativeExactAt(state, binding(SYNCED), through, at(10), () => FOREIGN), false, "foreign facts above the mark up to the Turn are owed");
  assert.equal(nativeExactAt(state, binding(SYNCED), through, at(6), () => FOREIGN), true, "none up to the Turn: the mark covers 3 and 6");
});

test("G068 fix2 I-1b holdsNothing: a binding whose native session the relay counts on for nothing — fresh, without the starting history, nothing ever dispatched into it, no Turn of its Harness control in an epoch it holds — and nothing else", () => {
  const fresh2 = relay({ kind: "fresh", basis: "user_cleared" }, { nativeEpoch: 2, epochFloor: 12, packetsInEpoch: 0 });
  const ran = (epoch: number | null, extra: Partial<PublicRun> = {}) => ({ id: runId("run-x" + epoch), selection: X, status: "completed", timing: { acceptedAt: 1, dispatchedAt: 2 },
    ...(epoch === null ? {} : { relay: { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...X, nativeEpoch: epoch } } }), ...extra }) as unknown as PublicRun;
  const archived = binding(relay({ kind: "fresh", basis: "new" }), { status: "archived", checkpoint: "native-old" });
  assert.equal(holdsNothing(snapshot([binding(fresh2)]), binding(fresh2)), true, "nothing ran on it");
  assert.equal(holdsNothing(snapshot([binding(fresh2)], { runs: [ran(2)] }), binding(fresh2)), false, "a Turn of its own epoch");
  assert.equal(holdsNothing(snapshot([binding(fresh2)], { runs: [ran(1)] }), binding(fresh2)), false, "a Turn of the epoch before, on this very native session (R1: a clear raised it in place)");
  assert.equal(holdsNothing(snapshot([archived, binding(fresh2)], { runs: [ran(1)] }), binding(fresh2)), true, "a Turn of an archived native session's epoch");
  assert.equal(holdsNothing(snapshot([binding(fresh2)], { runs: [ran(null)] }), binding(fresh2)), false, "a Turn the relay cannot place");
  assert.equal(holdsNothing(snapshot([binding(fresh2)], { runs: [ran(2, { timing: { acceptedAt: 1 } } as Partial<PublicRun>)] }), binding(fresh2)), true, "a Turn never dispatched");
  assert.equal(holdsNothing(snapshot([binding(fresh2)], { runs: [ran(2, { selection: { harnessId: "yankee", controlId: "yankee-acp" } } as Partial<PublicRun>)] }), binding(fresh2)), true, "another Harness's");
  assert.equal(holdsNothing(snapshot([binding(fresh2)]), binding(fresh2, { throughRunId: R1 })), false, "something was dispatched into it");
  assert.equal(holdsNothing(snapshot([binding(fresh2)]), binding(relay({ kind: "fresh", basis: "new" }, { originIncluded: true }))), false, "it holds the starting history");
  for (const held of [SYNCED, pending(0), relay({ kind: "suspect", mark: null, cause: "clear_unconfirmed", floorCandidate: 12, carried: null, rewound: false })])
    assert.equal(holdsNothing(snapshot([binding(held)]), binding(held)), false, held.sync.kind + ": a binding with a watermark or in doubt");
  assert.equal(holdsNothing(snapshot([binding(fresh2)]), binding(fresh2, { opensNew: true })), false, "one that opens a new native session resumes nothing");
});

// ---------------------------------------------------------------------------------------------------------------------
// The permissive defaults (docs/proposals/relay/permissive-defaults.md)
// ---------------------------------------------------------------------------------------------------------------------

const AUTO = { whenUnsure: "auto" as const };
/** The decision of `decide` under the policy, or the relay error it threw. */
function auto(state: BindingRelayState, choices: RelayChoices = {}, extra: Partial<DecideInput> = {}) {
  try { return decide(state, choices, { ...AUTO, ...extra }); } catch (error) { if (error instanceof RelayError) return error.code + "{" + error.reason + "}"; throw error; }
}
const NEWER: readonly RelayFact[] = [...FOREIGN, { runId: runId("run-y11"), seq: 11, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }];
const doubted = (cause: "rewind" | "unknown_command" | "legacy" | "marker_absent" | "clear_unconfirmed" | "unknown_turn", extra: Partial<Extract<BindingSync, { kind: "suspect" }>> = {}) =>
  relay({ kind: "suspect", mark: MARK1, cause, floorCandidate: cause === "clear_unconfirmed" ? 12 : null, carried: null, rewound: false, ...extra });

test("permissive §2.1 decideTurn: a pending packet is sent again once by itself by a Driver that can show delivery — lateDelivery included — then the input goes alone, and newer facts send it again with the count started over; never a question", () => {
  // Row 1: the automatic resend; the late-writing Driver gets it too (its resend carries a dedupe line).
  for (const lateDelivery of [false, true]) {
    const declaration = relayDeclaration(caps({ lateDelivery, successProvesRecorded: true }));
    const first = decide(pending(0), {}, { ...AUTO, declaration });
    assert.ok(first.kind === "carry" && first.resend?.by === "auto" && first.by === "policy" && first.cause === "delivery_unconfirmed" && first.lateDelivery === false, JSON.stringify({ lateDelivery }));
    assert.equal(auto(pending(1), {}, { declaration }) && (auto(pending(1), {}, { declaration }) as { kind: string }).kind, "alone");
  }
  // Row 2: spent and nothing newer: alone, by the policy, for this cause; the strict design asks (409).
  assert.deepEqual(auto(pending(1)), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
  assert.equal(refused(() => decide(pending(1))), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  assert.equal(refused(() => decide(pending(1), {}, { whenUnsure: "ask" })), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  // Row 3: a fact newer than the pending packet's: sent again (grown), the count started over; the user's choice still wins.
  const grown = auto(pending(1), {}, { facts: NEWER });
  assert.ok(typeof grown === "object" && grown.kind === "carry" && grown.resend?.by === "grown" && grown.resend.of === R2 && grown.need.facts.map(fact => fact.seq).join() === "7,9,11" && grown.by === "policy");
  const asked = auto(pending(1), { resend: true }, { facts: NEWER });
  assert.ok(typeof asked === "object" && asked.kind === "carry" && asked.resend?.by === "user" && asked.by === "user" && asked.cause === undefined);
  // Row 4: a Driver that can show nothing never gets the automatic resend; only newer facts send it again.
  const mute = relayDeclaration(null);
  assert.deepEqual(auto(pending(0), {}, { declaration: mute }), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
  const muteGrown = auto(pending(0), {}, { declaration: mute, facts: NEWER });
  assert.ok(typeof muteGrown === "object" && muteGrown.kind === "carry" && muteGrown.resend?.by === "grown");
  // Without the Run that carried it a resend cannot name what it supersedes: alone by the policy, the user's choice fails.
  assert.deepEqual(auto(pending(0), {}, { pendingRun: null }), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
  assert.equal(auto(pending(0), { resend: true }, { pendingRun: null }), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  // The user's own: alone is theirs, by "user".
  assert.deepEqual(auto(pending(1), { attach: "none" }), { kind: "alone", by: "user" });
});

test("permissive §2.2 and §2.3 decideTurn: a binding in doubt owed nothing newer is sent to alone, owed newer facts it gets the complete packet again (any cause, legacy and marker_absent included); the strict design asks; the user's complete packet is theirs", () => {
  for (const cause of ["rewind", "unknown_command", "clear_unconfirmed", "unknown_turn"] as const) {
    const state = doubted(cause);
    // Row 5 / 8: no newer fact above the mark: alone, the binding untouched; foreign facts exist, so the strict design would ask.
    assert.deepEqual(auto(state, {}, { facts: FOREIGN.slice(0, 2) }), { kind: "alone", by: "policy", cause: "verify_required" }, cause);
    assert.equal(refused(() => decide(state, {}, { facts: FOREIGN.slice(0, 2) })), "RELAY_CHOICE_REQUIRED{verify_required}", cause + ": strict");
    // Row 6 / 8: newer facts above the mark: the complete packet from the epoch base, by the policy.
    const retreat = auto(state, {}, { facts: NEWER });
    assert.ok(typeof retreat === "object" && retreat.kind === "carry" && retreat.retreat?.firstFromSeq === 3 && retreat.by === "policy" && retreat.cause === "verify_required" && retreat.need.facts.map(fact => fact.seq).join() === "3,6,7,9,11", cause);
    assert.equal(refused(() => decide(state, {}, { facts: NEWER })), "RELAY_CHOICE_REQUIRED{verify_required}", cause + ": strict");
    // The user's own choice is theirs.
    const user = auto(state, { attach: "full" }, { facts: NEWER });
    assert.ok(typeof user === "object" && user.kind === "carry" && user.by === "user" && user.cause === undefined, cause);
  }
  // Row 7: a marker found absent, and legacy: owing nothing newer they go as typed (nothing_owed); owed something, the complete packet again.
  for (const cause of ["marker_absent", "legacy"] as const) {
    assert.deepEqual(auto(doubted(cause), {}, { facts: FOREIGN.slice(0, 2) }), { kind: "plain", foreign: true, nothingToAttach: false }, cause + " owing nothing");
    const retreat = auto(doubted(cause), {}, { facts: NEWER });
    assert.ok(typeof retreat === "object" && retreat.kind === "carry" && retreat.retreat !== undefined && retreat.cause === (cause === "marker_absent" ? "marker_absent" : "verify_required"), cause + " owing newer facts");
  }
  // The retreated prior owing nothing is R5 whoever chose it: as typed, the binding standing there; a mark that does not come back (legacy) is refused → alone by the policy.
  const atFloor: DeliveredMark = { throughSeq: 10, chain: chainAfter(null, SHA1), lastPacketId: P1, evidence: "E3", basis: "evidence" };
  const stuck = relay({ kind: "suspect", mark: atFloor, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, { nativeEpoch: 2, epochFloor: 10 });
  const older: readonly RelayFact[] = [{ runId: R1, seq: 4, executedOn: { ...X, nativeEpoch: 1 } }, { runId: runId("run-y12"), seq: 12, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }];
  const typed = auto(stuck, {}, { facts: older, firstFromSeq: 4 });
  assert.ok(typeof typed === "object" && typed.kind === "carry" && typed.by === "policy", "a newer fact above the mark: the complete packet");
  // A fact that is owed nothing: no foreign fact → as typed.
  assert.deepEqual(auto(doubted("rewind"), {}, { facts: [] }), { kind: "plain", foreign: false, nothingToAttach: false });
});

test("permissive §2.4/§2.5 decideTurn: a relay record that could not be recovered, in every branch, sends the input alone for the policy and fails for the user's own choice; the strict design fails", () => {
  const down = { recoveryFailed: true };
  assert.deepEqual(auto(SYNCED, {}, down), { kind: "alone", by: "policy", cause: "recovery_failed" });
  assert.deepEqual(auto(pending(0), {}, down), { kind: "alone", by: "policy", cause: "recovery_failed" });
  assert.deepEqual(auto(doubted("rewind"), {}, { ...down, facts: NEWER }), { kind: "alone", by: "policy", cause: "recovery_failed" });
  assert.equal(auto(SYNCED, { attach: "full" }, down), "RELAY_UNAVAILABLE{recovery_failed}", "an explicit attach is held to it");
  assert.equal(auto(SYNCED, { native: "new" }, down), "RELAY_UNAVAILABLE{recovery_failed}");
  assert.equal(refused(() => decide(SYNCED, {}, down)), "RELAY_UNAVAILABLE{recovery_failed}", "strict");
  // Nothing to carry: never stopped.
  assert.deepEqual(auto(SYNCED, {}, { ...down, facts: FOREIGN.slice(0, 2) }), { kind: "plain", foreign: true, nothingToAttach: false });
});

test("permissive §2.6 decisionRecord and attention: what the Turn records of its decision, and what a binding asks the user to look at — never a block, one episode one key", () => {
  assert.deepEqual(decisionRecord(auto(pending(1)) as never), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
  assert.deepEqual(decisionRecord(decide(SYNCED)), { kind: "carry", by: "need" });
  assert.equal(decisionRecord(decide(SYNCED, {}, { facts: FOREIGN.slice(0, 2) })), null, "an ordinary Turn that owes nothing records none");
  assert.deepEqual(decisionRecord(decide(SYNCED, { attach: "full" }, { facts: FOREIGN.slice(0, 2) })), { kind: "plain", by: "user" });
  assert.deepEqual(decisionRecord({ kind: "alone", by: "policy", cause: "prepare_failed", reason: "storage_quota" }), { kind: "alone", by: "policy", cause: "prepare_failed", reason: "storage_quota" });
  assert.deepEqual(relayDecisionOf({ relay: { decision: { kind: "alone", by: "policy", cause: "input_limit", reason: "min_packet" } } }), { kind: "alone", by: "policy", cause: "input_limit", reason: "min_packet" });
  assert.equal(relayDecisionOf({ relay: { decision: { kind: "nope", by: "policy" } } }), null); assert.equal(relayDecisionOf({}), null);
  const owedTwo = { owedRuns: 2, recoveryFailed: false, latest: null };
  assert.deepEqual(attentionOf({ ...owedTwo, relay: pending(1) }), { cause: "delivery_unconfirmed", options: ["attach_full", "new_native"], counts: { runs: 2, packets: 2 }, key: "delivery_unconfirmed:" + P2 });
  assert.equal(attentionOf({ ...owedTwo, relay: doubted("rewind") })?.cause, "verify_required");
  assert.equal(attentionOf({ ...owedTwo, relay: doubted("marker_absent") })?.cause, "marker_absent");
  assert.equal(attentionOf({ ...owedTwo, relay: doubted("legacy") })?.cause, "verify_required");
  const clear = attentionOf({ ...owedTwo, relay: doubted("clear_unconfirmed") })!;
  assert.equal(clear.cause, "clear_unconfirmed"); assert.deepEqual(clear.options, ["attach_full", "new_native", "clear_confirmed"]);
  assert.deepEqual(attentionOf({ ...owedTwo, relay: SYNCED, recoveryFailed: true }), { cause: "recovery_failed", options: ["new_native"], counts: { runs: 2, packets: 0 }, key: "recovery_failed:1" });
  assert.equal(attentionOf({ ...owedTwo, relay: SYNCED }), null, "a binding that needs nothing");
  const sentAlone = (cause: NonNullable<ReturnType<typeof decisionRecord>>["cause"]) => attentionOf({ ...owedTwo, relay: SYNCED, latest: { kind: "alone", by: "policy", ...(cause === undefined ? {} : { cause }) } });
  assert.deepEqual(sentAlone("input_limit"), { cause: "input_limit", options: [], counts: { runs: 2, packets: 0 }, key: "input_limit:1" });
  assert.deepEqual(sentAlone("consent_revoked")?.options, ["acknowledge"]); assert.equal(sentAlone("consent_goal_only")?.cause, "consent_goal_only");
  assert.equal(sentAlone("prepare_failed"), null, "a failed preparation is told with the Turn, it is no standing banner");
  assert.equal(attentionOf({ ...owedTwo, owedRuns: 0, relay: SYNCED, latest: { kind: "alone", by: "policy", cause: "input_limit" } }), null, "nothing owed: nothing to say");
  // One episode, one key: the same pending packet keeps its key whatever the counts; a new packet is a new episode.
  assert.equal(attentionOf({ ...owedTwo, relay: pending(0) })!.key, attentionOf({ ...owedTwo, relay: pending(1) })!.key);
});

test("permissive §2 policyAloneOf: which failures concern the packet only — settled by sending the input alone for the policy; the strict setting, a request that steered the relay, a failure of the message itself and the settings' own gates are not", () => {
  const e = (code: string, reason: string) => new RelayError({ code, reason } as never, "x");
  const hits: readonly (readonly [RelayError | SessionError, ReturnType<typeof policyAloneOf>])[] = [
    [e("RELAY_INPUT_LIMIT", "min_packet"), { cause: "input_limit", reason: "min_packet" }], [e("RELAY_INPUT_LIMIT", "input_limit"), { cause: "input_limit", reason: "input_limit" }],
    [e("RELAY_UNAVAILABLE", "recovery_failed"), { cause: "recovery_failed" }], [e("RELAY_UNAVAILABLE", "consent_log_full"), { cause: "prepare_failed", reason: "consent_log_full" }],
    [e("RELAY_CONSENT_REQUIRED", "revoked"), { cause: "consent_revoked" }], [e("RELAY_CONSENT_REQUIRED", "missing"), { cause: "consent_goal_only", reason: "missing" }],
    [e("RELAY_PREPARE_FAILED", "render"), { cause: "prepare_failed", reason: "render" }], [e("RELAY_PREPARE_FAILED", "storage_quota"), { cause: "prepare_failed", reason: "storage_quota" }],
    [e("RELAY_PREPARE_FAILED", "redaction_failed"), { cause: "prepare_failed", reason: "redaction_failed" }], [e("RELAY_PREPARE_FAILED", "render_mismatch"), { cause: "prepare_failed", reason: "render_mismatch" }],
    [e("RELAY_CHOICE_REQUIRED", "verify_required"), { cause: "verify_required" }], [new SessionError("RELAY_PREPARE_FAILED", "secrets"), { cause: "prepare_failed", reason: "redaction_failed" }],
  ];
  for (const [error, expected] of hits) assert.deepEqual(policyAloneOf(error, DEFAULT_SETTINGS, {}), expected, error.message + " " + (error as RelayError).reason);
  for (const error of [e("RELAY_PREPARE_FAILED", "target_start"), e("RELAY_PREPARE_FAILED", "classification_changed"), e("RELAY_TARGET_UNVERIFIED", "unprobed"), e("RELAY_UNAVAILABLE", "data_root_in_workspace"), new SessionError("CANCELLED", "x"), new Error("boom")])
    assert.equal(policyAloneOf(error, DEFAULT_SETTINGS, {}), null, (error as Error).message);
  for (const [error] of hits) {
    assert.equal(policyAloneOf(error, { ...DEFAULT_SETTINGS, whenUnsure: "ask" }, {}), null, "whenUnsure ask: the Run fails as the strict design's");
    for (const choices of [{ attach: "full" }, { resend: true }, { clearConfirmed: true }, { native: "new" }] as const) assert.equal(policyAloneOf(error, DEFAULT_SETTINGS, choices), null, JSON.stringify(choices) + ": the user steered the relay");
    assert.notEqual(policyAloneOf(error, DEFAULT_SETTINGS, { tier: "brief", consent: { vendor: "openai", decision: "acknowledged", scope: "session" } }), null, "a tier and a consent steer nothing");
  }
  assert.equal(policyAloneOf(e("RELAY_CONSENT_REQUIRED", "revoked"), { ...DEFAULT_SETTINGS, crossVendor: "ask" }, {}), null, "crossVendor ask: the strict consent asks");
  assert.deepEqual(policyAloneOf(e("RELAY_CONSENT_REQUIRED", "revoked"), { ...DEFAULT_SETTINGS, crossVendor: "goal_only" }, {}), { cause: "consent_revoked" });
  assert.equal(explicitChoice({ attach: "full" }) && explicitChoice({ resend: true }) && explicitChoice({ clearConfirmed: true }) && explicitChoice({ native: "new" }), true);
  assert.equal(explicitChoice({}) || explicitChoice({ attach: "none" }) || explicitChoice({ tier: "brief" }) || explicitChoice({ native: "continue" }), false);
});

const view = (records: readonly ConsentRecord[], crossVendor: ConsentView["crossVendor"], extra: Partial<ConsentView> = {}): ConsentView => ({ session: sessionId("session-unit"), records, crossVendor, localModelsOffline: false, request: null, ...extra });
const logged = (vendor: string, decision: ConsentRecord["decision"], logSeq: number, scope: ConsentRecord["scope"] = { kind: "global" }, commandId = "user-" + logSeq): ConsentRecord =>
  ({ logSeq, commandId, vendor: vendor as VendorKey, scope, decision, categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 1 });

test("permissive §2.4 consent: allow covers every key — unknown, gateway, router, Provider and a workspace file's endpoint — unless withdrawn, and a vendor change goes with a record; ask and goal_only keep the strict design; a row the default wrote is no consent the user gave", () => {
  const keys = ["anthropic", "openai", "local", "unknown:codex", "gateway:api.example.com", "router:openrouter", "provider:ollama"] as const;
  for (const key of keys) {
    assert.deepEqual(consentStanding(key, "workspace_file", view([], "allow")), { kind: "given", decision: "acknowledged", logSeq: null, via: "default" }, key);
    assert.deepEqual(consentStanding(key, null, view([logged(key, "revoked", 3)], "allow")), { kind: "missing", revoked: true }, key + ": a withdrawal beats the default");
    assert.deepEqual(consentStanding(key, null, view([logged(key, "acknowledged", 4)], "allow")), { kind: "given", decision: "acknowledged", logSeq: 4, via: "global" }, key + ": the latest row stands");
    assert.equal(consentStanding(key, null, view([], "ask")).kind, "missing", key + ": ask asks");
  }
  // "本机模型不出网" exempts under the strict design only: the default logs every first use.
  assert.deepEqual(consentStanding("local", null, view([], "ask", { localModelsOffline: true })), { kind: "exempt" });
  assert.equal(consentStanding("local", null, view([], "allow", { localModelsOffline: true })).kind, "given");
  // Default rows count only while the preference is allow.
  const row = defaultRow("openai");
  assert.equal(consentStanding("openai", null, view([row], "allow")).kind, "given"); assert.equal((consentStanding("openai", null, view([row], "allow")) as { via: string }).via, "global");
  assert.equal(consentStanding("openai", null, view([row], "ask")).kind, "missing", "a row the default wrote is no consent under ask");
  assert.equal(consentStanding("openai", null, view([row], "goal_only")).kind, "given", "goal_only covers a named vendor for the goal only, with or without the row");
  assert.equal((consentStanding("openai", null, view([row], "goal_only")) as { decision: string }).decision, "goal_only");
  assert.equal(consentStanding("gateway:api.example.com", null, view([defaultRow("gateway:api.example.com")], "goal_only")).kind, "missing");
  // consentGate: allow lets a vendor change go, naming where it came from; the strict design refuses; revoked refuses under allow.
  const kept = relay({ kind: "synced", mark: MARK1 }, { consentKey: "openai" as VendorKey });
  const gate = (preference: ConsentView["crossVendor"], vendor: string, cross: boolean, records: readonly ConsentRecord[] = []) =>
    consentGate({ relay: kept, vendor: vendor as VendorKey, layer: null, cross, consent: view(records, preference), target: X, predicted: null });
  assert.deepEqual(gate("allow", "deepseek", true), { standing: { kind: "given", decision: "acknowledged", logSeq: null, via: "default" }, changedFrom: "openai" });
  assert.deepEqual(gate("allow", "deepseek", false), { standing: { kind: "given", decision: "acknowledged", logSeq: null, via: "default" }, changedFrom: "openai" }, "a change within one family is traced too");
  assert.deepEqual(gate("allow", "openai", false), { standing: null, changedFrom: null });
  assert.throws(() => gate("ask", "deepseek", true), (error: unknown) => error instanceof RelayError && error.reason === "vendor_changed");
  assert.throws(() => gate("allow", "openai", true, [logged("openai", "revoked", 5)]), (error: unknown) => error instanceof RelayError && error.reason === "revoked");
  assert.throws(() => gate("goal_only", "deepseek", true), (error: unknown) => error instanceof RelayError && error.reason === "vendor_changed");
});
function defaultRow(vendor: string, logSeq = 7): ConsentRecord {
  const append = defaultAllowAppend(vendor as VendorKey, null, 5);
  return parseConsentRecord({ ...append, logSeq });
}

test("permissive §4 settings and the log row: the defaults are permissive and a stored value overrides them; the strict preferences are the four; a default-allow row names its vendor and policy, is idempotent and says its source", () => {
  assert.deepEqual(relaySettings({}), { crossVendor: "allow", whenUnsure: "auto", allowUnprobed: true, dataRootInWorkspace: "warn", returnPreference: "continue", localModelsOffline: false });
  assert.deepEqual(relaySettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(relaySettings(RELAY_STRICT_PREFS), { ...STRICT_SETTINGS });
  assert.deepEqual(relaySettings({ "relay.crossVendor": "goal_only", "relay.returnPreference": "ask", "relay.localModelsOffline": "true" } as never), { ...DEFAULT_SETTINGS, crossVendor: "goal_only", returnPreference: "ask", localModelsOffline: true });
  assert.deepEqual(relaySettings({ "relay.crossVendor": "bogus", "relay.whenUnsure": "bogus", "relay.allowUnprobed": "bogus" } as never), { ...DEFAULT_SETTINGS, allowUnprobed: true }, "an unreadable value is the default");
  assert.deepEqual([...RELAY_PREF_KEYS].sort(), Object.keys(RELAY_PREF_DEFAULTS).sort());
  for (const key of RELAY_PREF_KEYS) assert.ok(RELAY_PREF_VALUES[key].includes(RELAY_PREF_DEFAULTS[key]), key + "'s default is one of its values");
  for (const [key, value] of Object.entries(RELAY_STRICT_PREFS)) assert.ok(RELAY_PREF_VALUES[key as keyof typeof RELAY_PREF_VALUES].includes(value!), key);
  const append = defaultAllowAppend("openai" as VendorKey, "account", 99);
  assert.deepEqual({ ...append, categories: undefined }, { commandId: "default-allow:openai:relay-1", vendor: "openai", scope: { kind: "global" }, decision: "acknowledged", categories: undefined, policyVersion: "relay/1", authKind: "account", decidedAt: 99 });
  assert.equal(consentSourceOf({ commandId: append.commandId }), "default"); assert.equal(consentSourceOf({ commandId: "send-1" }), "user");
  assert.equal(defaultAllowAppend("openai" as VendorKey, null, 1).commandId, append.commandId, "the same vendor and policy, the same command");
  // A command identity has bounds the vendor key may exceed (a 253-byte gateway host): named by a digest then, still stable, still a valid record.
  const long = "gateway:" + "a".repeat(60) + "." + "b".repeat(60) + "." + "c".repeat(60) + ".example.com";
  const longId = defaultAllowCommand(long as VendorKey, "relay/1");
  assert.ok(Buffer.byteLength(longId) <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(longId), longId); assert.equal(longId, defaultAllowCommand(long as VendorKey, "relay/1"));
  assert.notEqual(longId, defaultAllowCommand((long + "x") as VendorKey, "relay/1"));
  assert.ok(parseConsentRecord({ ...defaultAllowAppend(long as VendorKey, null, 1), logSeq: 1 }).commandId.startsWith("default-allow:"));
});

test("permissive §0 admitRelay under the defaults: an input is refused for nothing the policy settles — the recovery, the user's choice, the consent, the window — and only a strict preference or a request that steered the relay is held to them", () => {
  const settings: RelaySettings = DEFAULT_SETTINGS, withSettings = (value: RelaySettings) => ({ settings: value });
  const attempt = (state: BindingRelayState, choices: RelayChoices, value: RelaySettings, extra: Parameters<typeof admit>[2] = {}): string => {
    const bound = binding(state), at = snapshot([bound], extra.extra);
    try { admitRelay({ state: at, binding: bound, target: X, capabilities: caps(), text: "hello", attachments: [], choices, facts: () => extra.facts ?? FOREIGN, ...withSettings(value) }); return "ok"; }
    catch (error) { if (error instanceof RelayError) return error.code + "{" + error.reason + "}"; if (error instanceof SessionError) return error.code; throw error; }
  };
  const cases: readonly (readonly [string, BindingRelayState, Parameters<typeof admit>[2], string])[] = [
    ["a spent pending packet", pending(1), {}, "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}"], ["a binding in doubt", doubted("rewind"), {}, "RELAY_CHOICE_REQUIRED{verify_required}"],
    ["a marker absent", doubted("marker_absent"), {}, "RELAY_CHOICE_REQUIRED{marker_absent}"], ["a record that could not be recovered", pending(0), { extra: { relayRecoveryFailed: 3 } }, "RELAY_UNAVAILABLE{recovery_failed}"],
  ];
  for (const [label, state, extra, strict] of cases) {
    assert.equal(attempt(state, {}, STRICT_SETTINGS, extra), strict, label + ": strict");
    assert.equal(attempt(state, {}, { ...settings, whenUnsure: "ask" }, extra), strict, label + ": whenUnsure ask");
    assert.equal(attempt(state, {}, settings, extra), "ok", label + ": the defaults ask nothing");
    assert.equal(attempt(state, { attach: "full" }, settings, extra), label.includes("recovered") ? strict : "ok", label + ": an explicit attach");
  }
  assert.equal(attempt(pending(1), { resend: true }, settings), "ok");
  // The user's ［确认已清空］ where it is not offered is a mistake of theirs, answered whatever the settings.
  assert.equal(attempt(SYNCED, { clearConfirmed: true }, settings), "INVALID_INPUT");
});
