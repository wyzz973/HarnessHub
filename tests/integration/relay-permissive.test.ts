import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { RelayError, consentSourceOf, relayDecisionOf, type RelayDecision, type VendorKey } from "../../src/contracts/relay.js";
import { SessionError, type PublicRun, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import type { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { CHECKING, Fakes, declared, endpoint, eventOf, events, fromAlpha, refusedAt, relayOf, seen, to, turn, world } from "../fixtures/relay-fakes.js";
import { strictRelay } from "../fixtures/relay-settings.js";

// The permissive defaults (ADR-055 "用户的决定（2026-11-10）", docs/proposals/relay/permissive-defaults.md): with nothing stored in
// relay_prefs the relay asks nothing it can settle itself — no RELAY_* 409 at send, every Run completes, what goes out is what
// the table's row says, the decision is recorded in run.context_prepared, and what repeats is bounded. Each test is one row (or
// two) of the table of §1 on a real SqliteSessionStore and fixture Harnesses (tests/fixtures/relay-fakes.ts); the same cases in
// the strict world are the existing tests (P9). Nothing here runs a Harness.

/**
 * The decision a Run recorded in run.context_prepared. P11 (如实) is checked on every Run the policy sent alone, whatever the
 * test: nothing of it says the history was handed over — no packet, no delivery row, no handover continuity.
 */
function decisionOf(store: SqliteSessionStore, id: SessionId, run: PublicRun): RelayDecision | null {
  const prepared = eventOf(store, id, "run.context_prepared", run.id), decision = prepared === undefined ? null : relayDecisionOf(prepared.data);
  if (decision?.kind === "alone") {
    assert.equal(run.relay?.packetId, null, "P11: a Run sent alone names no packet");
    assert.ok(run.relay?.continuity.kind !== "rehydrate" && run.relay?.continuity.kind !== "native_resume_delta" && run.relay?.continuity.kind !== "native_fork" && run.relay?.continuity.kind !== "native_import", "P11: " + JSON.stringify(run.relay?.continuity));
    assert.equal(store.relayDeliveries(id).some(row => row.runId === run.id), false, "P11: no delivery row");
    assert.equal(eventOf(store, id, "relay.input_recorded", run.id), undefined, "P11: no evidence of a delivery");
  }
  return decision;
}
const syncOf = (app: SessionRuntime, id: SessionId, harnessId: string) => relayOf(app.read(id), harnessId).sync;
/** Whether a prompt went to the Harness as typed (the words alone) or with a packet. */
const asTyped = (fakes: Fakes, harnessId: string, text: string): boolean => { const last = fakes.to(harnessId).at(-1)!; return typeof last.turn === "string" && last.text === text; };
/** A send that the relay must not stop: accepted, and its Run completed. */
async function accepted(app: SessionRuntime, fakes: Fakes, id: SessionId, text: string, key: string, relay?: Parameters<typeof turn>[4]): Promise<PublicRun> {
  const before = app.read(id).runs.length;
  const run = await turn(app, id, text, key, relay);
  assert.equal(app.read(id).runs.length, before + 1, "the input made a Run (no 409): " + text);
  assert.equal(run.status, "completed", text + ": " + (run.error?.code ?? ""));
  return run;
}
/** Two bravo Turns whose packets nothing confirms (every check unavailable, a completed Turn proves nothing): pending with the automatic resend spent. */
async function pendingSpent(t: Parameters<typeof fromAlpha>[0], extra: Parameters<typeof declared>[0] = {}) {
  const s = await fromAlpha(t, { bravo: declared({ ...CHECKING, ...extra }) }, "bravo");
  s.fakes.observed.bravo = seen("openai"); s.fakes.readable = false;
  s.fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
  const b1 = await accepted(s.app, s.fakes, s.id, "b1 carries a1", "b1"), b2 = await accepted(s.app, s.fakes, s.id, "b2 resends it", "b2");
  return { ...s, b1, b2 };
}

test("row 1 (§2.1): a packet still unconfirmed after the check is sent again once by itself — also for a Driver whose cancelled inputs may land late — with the next message, never asking; the Run completes and says so", async t => {
  for (const lateDelivery of [false, true]) {
    const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared({ ...CHECKING, lateDelivery }) }, "bravo");
    fakes.observed.bravo = seen("openai"); fakes.readable = false;   // every check answers unavailable
    fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
    const b1 = await accepted(app, fakes, id, "b1 carries a1", "b1");
    assert.equal(syncOf(app, id, "bravo").kind, "pending", "no evidence: pending");
    assert.deepEqual(decisionOf(w.store, id, b1), { kind: "carry", by: "need" });
    assert.equal(refusedAt(app, fakes, id, "b2 would resend", "b2"), "accepted", "no 409"); await app.wait(id);
    const b2 = app.read(id).runs.at(-1)!;
    assert.equal(b2.status, "completed", "lateDelivery " + lateDelivery);
    assert.deepEqual(decisionOf(w.store, id, b2), { kind: "carry", by: "policy", cause: "delivery_unconfirmed" });
    assert.deepEqual(b2.sourceRunIds, [a1.id], "the resend renders all that is owed again");
    assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object", "a packet went with b2");
    assert.equal(eventOf(w.store, id, "run.context_prepared", b2.id)!.data.resendOf, b1.id);
    const sync = syncOf(app, id, "bravo");
    assert.ok(sync.kind === "pending" && sync.autoResends === 1 && sync.manualResends === 0);
  }
});

test("rows 2 and 3 (§2.1): the packet sent twice and still unconfirmed, nothing newer: the policy sends the input alone twenty times over, the binding byte for byte as it was and no row written; newer facts send it again (grown) and the count starts again", async t => {
  const { w, fakes, app, id, a1, b2 } = await pendingSpent(t);
  const rows = w.store.relayDeliveries(id).length, state = JSON.stringify(relayOf(app.read(id), "bravo")), seqBefore = app.read(id).lastSeq;
  assert.equal(rows, 2);
  const sentBefore = fakes.to("bravo").length;
  for (let n = 3; n < 23; n++) {
    const run = await accepted(app, fakes, id, "b" + n + " as typed", "b" + n);
    assert.ok(asTyped(fakes, "bravo", "b" + n + " as typed"), "dispatched === input");
    assert.deepEqual(decisionOf(w.store, id, run), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
    assert.deepEqual(run.relay?.continuity, { kind: "native_resume" }, "P11: nothing says it was handed over"); assert.equal(run.relay?.packetId, null);
    assert.equal(eventOf(w.store, id, "relay.input_recorded", run.id), undefined);
  }
  assert.equal(fakes.to("bravo").length, sentBefore + 20);
  assert.equal(w.store.relayDeliveries(id).length, rows, "P6: twenty inputs, no further delivery row");
  assert.equal(JSON.stringify(relayOf(app.read(id), "bravo")), state, "P4: the binding is exactly as it was");
  assert.ok(events(w.store, id).filter(row => row.seq > seqBefore).every(row => row.type !== "relay.verified" || row.data.result !== "recorded"));
  // The banner (§2.6) says the packet is unconfirmed after two sends.
  const bravo = app.relayAttention(id).find(row => row.harnessId === "bravo")!;
  assert.equal(bravo.attention?.cause, "delivery_unconfirmed"); assert.deepEqual(bravo.attention?.counts, { runs: 1, packets: 2 });
  // Row 3: a newer fact (alpha's own Turn) is owed too: the packet goes again, with it, and the automatic count starts again.
  await to(app, id, "alpha", "to-a"); const a2 = await accepted(app, fakes, id, "a2 a newer fact", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
  const grown = await accepted(app, fakes, id, "b-grown carries the newer fact", "b-grown");
  assert.deepEqual(decisionOf(w.store, id, grown), { kind: "carry", by: "policy", cause: "delivery_unconfirmed" });
  assert.ok(grown.sourceRunIds.includes(a1.id) && grown.sourceRunIds.includes(a2.id), "all that is owed, the unconfirmed one's facts included");
  assert.equal(eventOf(w.store, id, "run.context_prepared", grown.id)!.data.resendOf, b2.id, "it supersedes the packet that was waiting");
  const after = syncOf(app, id, "bravo");
  assert.ok(after.kind === "pending" && after.autoResends === 0 && after.manualResends === 0, "grown: the count starts again at 0");
  // Bounded again: the same facts at most one more time by themselves, then alone.
  const again = await accepted(app, fakes, id, "b-again", "b-again");
  assert.equal(decisionOf(w.store, id, again)?.by, "policy"); assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object");
  const rest = await accepted(app, fakes, id, "b-rest", "b-rest");
  assert.deepEqual(decisionOf(w.store, id, rest), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }); assert.ok(asTyped(fakes, "bravo", "b-rest"));
});

test("row 4 (§2.1, B9): a Driver that declares nothing (WorkBuddy as a target) takes the history too, once, with no automatic resend; only newer facts send it again; its state is 'cannot be confirmed', not a failure", async t => {
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: null }, "bravo");
  fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
  const b1 = await accepted(app, fakes, id, "b1 carries a1", "b1");
  assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object", "no probe gate, no 409: the history goes");
  assert.deepEqual(b1.sourceRunIds, [a1.id]);
  assert.equal(syncOf(app, id, "bravo").kind, "pending", "nothing can confirm it");
  for (let n = 2; n < 6; n++) { await accepted(app, fakes, id, "b" + n, "b" + n); assert.ok(asTyped(fakes, "bravo", "b" + n), "no automatic resend of a send nothing can ever confirm"); }
  assert.equal(w.store.relayDeliveries(id).length, 1);
  await to(app, id, "alpha", "to-a"); await accepted(app, fakes, id, "a2 newer", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
  const grown = await accepted(app, fakes, id, "b-grown", "b-grown");
  assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object", "newer facts send it again"); assert.equal(decisionOf(w.store, id, grown)?.cause, "delivery_unconfirmed");
  assert.equal(w.store.relayDeliveries(id).length, 2);
  await accepted(app, fakes, id, "b-after", "b-after"); assert.ok(asTyped(fakes, "bravo", "b-after"));
  assert.equal(w.store.relayDeliveries(id).length, 2, "and again nothing");
});

/** A conversation on bravo (openai, no way to check) whose packet of alpha's a1 was recorded, then the user's command `command` ran there. */
async function afterCommand(t: Parameters<typeof fromAlpha>[0], command: string, key: string, extra: Parameters<typeof declared>[0] = {}) {
  const s = await fromAlpha(t, { bravo: declared(extra) }, "bravo");
  s.fakes.observed.bravo = seen("openai");
  const b1 = await accepted(s.app, s.fakes, s.id, "b1 carries a1", "b1");
  assert.equal(syncOf(s.app, s.id, "bravo").kind, "synced", "recorded by the completed Turn (E3)");
  await accepted(s.app, s.fakes, s.id, command, key);
  return { ...s, b1 };
}
async function newFactOnAlpha(s: Awaited<ReturnType<typeof fromAlpha>>, text: string, key: string, back = "bravo") {
  await to(s.app, s.id, "alpha", "to-a-" + key); const run = await accepted(s.app, s.fakes, s.id, text, key, { attach: "none" }); await to(s.app, s.id, back, "back-" + key);
  return run;
}

test("rows 5 and 6 (§2.2): a rewound binding no check can settle — nothing newer owed: the input goes alone and the binding stays in doubt; newer facts owed: the complete packet again in the same native session; never asked, never an epoch or floor raised", async t => {
  const s = await afterCommand(t, "/undo", "undo"), { w, fakes, app, id, a1 } = s;
  const doubt = syncOf(app, id, "bravo");
  assert.ok(doubt.kind === "suspect" && doubt.cause === "rewind");
  const floor = relayOf(app.read(id), "bravo");
  const b3 = await accepted(app, fakes, id, "b3 as typed", "b3");
  assert.ok(asTyped(fakes, "bravo", "b3 as typed"));
  assert.deepEqual(decisionOf(w.store, id, b3), { kind: "alone", by: "policy", cause: "verify_required" });
  assert.deepEqual(syncOf(app, id, "bravo"), doubt, "row 5: the binding is still in doubt, as it was (kept for the next open's check)");
  assert.equal(relayOf(app.read(id), "bravo").epochFloor, floor.epochFloor); assert.equal(relayOf(app.read(id), "bravo").nativeEpoch, floor.nativeEpoch);
  const banner = app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention!;
  assert.equal(banner.cause, "verify_required"); assert.ok(banner.options.includes("attach_full") && !banner.options.includes("clear_confirmed"));
  // Row 6: a newer fact (alpha's a2) is owed above the doubtful mark: the policy retreats to the epoch base and sends the complete packet.
  const a2 = await newFactOnAlpha(s, "a2 a newer fact", "a2");
  const b4 = await accepted(app, fakes, id, "b4 carries all again", "b4");
  assert.deepEqual(decisionOf(w.store, id, b4), { kind: "carry", by: "policy", cause: "verify_required" });
  assert.equal(eventOf(w.store, id, "run.context_prepared", b4.id)!.data.retreat, true);
  assert.deepEqual(b4.sourceRunIds, [a1.id, a2.id], "the complete packet, a1 again (possibly a repeat) and a2");
  assert.equal(syncOf(app, id, "bravo").kind, "synced", "recorded");
  assert.equal(relayOf(app.read(id), "bravo").epochFloor, floor.epochFloor, "P3: no floor raised"); assert.equal(relayOf(app.read(id), "bravo").nativeEpoch, floor.nativeEpoch);
  // Bounded: recorded, nothing is owed any more; five more inputs add no packet.
  const rows = w.store.relayDeliveries(id).length;
  for (let n = 5; n < 10; n++) await accepted(app, fakes, id, "b" + n, "b" + n);
  assert.equal(w.store.relayDeliveries(id).length, rows);
});

test("row 7 (§2.2): the marker is not in the native history any more — nothing newer owed: as typed; newer facts owed: the complete packet again in the same session; no 409, no new native session", async t => {
  // The Driver checks at the open; the user removes the packet in the original program.
  const lost = (s: Awaited<ReturnType<typeof fromAlpha>>) => { s.fakes.history.get(s.fakes.to("bravo")[0]!.session)!.length = 0; };
  const s = await fromAlpha(t, { bravo: declared({ verify: "on_next_open" }) }, "bravo");
  s.fakes.observed.bravo = seen("openai");
  await accepted(s.app, s.fakes, s.id, "b1 carries a1", "b1"); lost(s);
  const b2 = await accepted(s.app, s.fakes, s.id, "b2 as typed", "b2");
  assert.ok(asTyped(s.fakes, "bravo", "b2 as typed"), "nothing newer is owed: as typed, as before");
  assert.equal(decisionOf(s.w.store, s.id, b2), null, "an ordinary Turn records no decision");
  assert.ok(eventOf(s.w.store, s.id, "relay.verified", b2.id)?.data.result === "marker_absent");
  // The same with a newer fact owed.
  const t2 = await fromAlpha(t, { bravo: declared({ verify: "on_next_open" }) }, "bravo");
  t2.fakes.observed.bravo = seen("openai");
  await accepted(t2.app, t2.fakes, t2.id, "b1 carries a1", "b1"); lost(t2);
  const a2 = await newFactOnAlpha(t2, "a2 a newer fact", "a2");
  const b3 = await accepted(t2.app, t2.fakes, t2.id, "b3 carries all again", "b3");
  assert.deepEqual(decisionOf(t2.w.store, t2.id, b3), { kind: "carry", by: "policy", cause: "marker_absent" });
  assert.equal(eventOf(t2.w.store, t2.id, "run.context_prepared", b3.id)!.data.retreat, true);
  assert.ok(b3.sourceRunIds.length === 2 && b3.sourceRunIds.includes(a2.id));
  assert.equal(t2.fakes.opens.filter(row => row.harnessId === "bravo").at(-1)!.checkpoint, t2.fakes.to("bravo")[0]!.session, "the same native session");
  const rows = t2.w.store.relayDeliveries(t2.id).length;
  for (let n = 4; n < 9; n++) await accepted(t2.app, t2.fakes, t2.id, "b" + n, "b" + n);
  assert.equal(t2.w.store.relayDeliveries(t2.id).length, rows, "bounded: nothing more is sent by itself");
});

test("row 8 (§2.3): an unconfirmed clear is taken as not having happened — the floor and the epoch stay; nothing newer owed: alone; newer facts owed: the complete packet, which brings the facts before the clear back; the banner offers ［确认已清空］", async t => {
  const s = await afterCommand(t, "/clear", "clear"), { w, fakes, app, id, a1 } = s;
  const doubt = syncOf(app, id, "bravo");
  assert.ok(doubt.kind === "suspect" && doubt.cause === "clear_unconfirmed");
  const before = relayOf(app.read(id), "bravo");
  const b3 = await accepted(app, fakes, id, "b3 as typed", "b3");
  assert.deepEqual(decisionOf(w.store, id, b3), { kind: "alone", by: "policy", cause: "verify_required" }); assert.ok(asTyped(fakes, "bravo", "b3 as typed"));
  assert.deepEqual(syncOf(app, id, "bravo"), doubt);
  assert.equal(relayOf(app.read(id), "bravo").epochFloor, before.epochFloor, "P3"); assert.equal(relayOf(app.read(id), "bravo").nativeEpoch, before.nativeEpoch);
  const banner = app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention!;
  assert.equal(banner.cause, "clear_unconfirmed"); assert.ok(banner.options.includes("clear_confirmed"));
  const a2 = await newFactOnAlpha(s, "a2 a newer fact", "a2");
  const b4 = await accepted(app, fakes, id, "b4 carries all again", "b4");
  assert.deepEqual(decisionOf(w.store, id, b4), { kind: "carry", by: "policy", cause: "verify_required" });
  assert.deepEqual(b4.sourceRunIds, [a1.id, a2.id], "the facts before the unconfirmed clear come back with the new one");
  assert.equal(relayOf(app.read(id), "bravo").epochFloor, before.epochFloor, "P3: still no floor"); assert.equal(relayOf(app.read(id), "bravo").nativeEpoch, before.nativeEpoch);
  const rows = w.store.relayDeliveries(id).length;
  for (let n = 5; n < 10; n++) await accepted(app, fakes, id, "b" + n, "b" + n);
  assert.equal(w.store.relayDeliveries(id).length, rows, "bounded: the complete packet was sent once");
});

test("row 9 (D6, §2.1): a Turn of a probed process Driver that ended unknown with its packet and was continued: the check cannot see it, the packet is back to pending with its resend spent — the next input goes alone, newer facts send it again; never asked", async t => {
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared({ ...CHECKING, probed: true }) }, "bravo");
  fakes.observed.bravo = seen("openai");
  fakes.script = (harnessId, input) => harnessId === "bravo" && input === "b1 lost but written" ? { result: "lost" } : {};
  const lost = await turn(app, id, "b1 lost but written", "b1");
  assert.equal(lost.status, "unknown"); assert.equal(app.read(id).status, "blocked");
  const binding = syncOf(app, id, "bravo");
  assert.ok(binding.kind === "suspect" && binding.cause === "unknown_turn" && binding.carried !== null);
  app.resume(id, { harnessId: "bravo" }, "recover", true); await app.wait(id);
  fakes.readable = false;   // the check at the next open cannot see
  const b2 = await accepted(app, fakes, id, "b2 goes alone", "b2");
  assert.ok(asTyped(fakes, "bravo", "b2 goes alone")); assert.deepEqual(decisionOf(w.store, id, b2), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
  const pending = syncOf(app, id, "bravo");
  assert.ok(pending.kind === "pending" && pending.autoResends === 1, "back to pending with the automatic resend spent");
  const a2 = await newFactOnAlpha({ w, fakes, app, id, a1 }, "a2 a newer fact", "a2");
  const b3 = await accepted(app, fakes, id, "b3 sends it again with the newer fact", "b3");
  assert.deepEqual(decisionOf(w.store, id, b3), { kind: "carry", by: "policy", cause: "delivery_unconfirmed" });
  assert.ok(b3.sourceRunIds.includes(a1.id) && b3.sourceRunIds.includes(a2.id));
});

/** Counts of the installation's log: what was appended, and in which order against the commits that carry `run.context_prepared`. */
function traced(store: SqliteSessionStore) {
  const order: string[] = [], append = store.appendRelayLog.bind(store), transact = store.transact.bind(store);
  store.appendRelayLog = record => { const row = append(record); order.push("log:" + row.logSeq); return row; };
  store.transact = (...args) => { const committed = transact(...args); if (committed.events.some(row => row.type === "run.context_prepared")) order.push("prepared"); return committed; };
  return order;
}
const defaults = (store: SqliteSessionStore) => store.relayConsents().filter(row => consentSourceOf(row) === "default");

test("row 10 (§2.4): a Driver whose probes have not proved its mechanisms takes the history, the card saying so; relay.allowUnprobed=false brings the 409 back", async t => {
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared({ probed: false }) }, "bravo");
  fakes.observed.bravo = seen("openai");
  assert.equal(refusedAt(app, fakes, id, "b0 is not stopped", "b0", { attach: "none" }), "accepted"); await app.wait(id);
  const b1 = await accepted(app, fakes, id, "b1 carries a1", "b1");
  assert.deepEqual(b1.sourceRunIds, [a1.id]); assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object");
  assert.deepEqual(decisionOf(w.store, id, b1), { kind: "carry", by: "need" });
  assert.equal(app.relayAttention(id).find(row => row.harnessId === "bravo")!.probed, false, "the card says so: not proved by a real Harness");
  assert.equal(app.relayAttention(id).find(row => row.harnessId === "alpha")!.probed, true);
  // The strict setting asks again (a fresh conversation, so there is something to carry).
  const strict = await fromAlpha(t, { bravo: declared({ probed: false }) }, "bravo", { strict: true });
  strict.fakes.observed.bravo = seen("openai");
  assert.equal(refusedAt(strict.app, strict.fakes, strict.id, "b1", "b1"), "RELAY_TARGET_UNVERIFIED{unprobed}");
  strict.w.store.setPref("relay.allowUnprobed", "true"); strict.w.store.setPref("relay.crossVendor", "allow");
  assert.equal(refusedAt(strict.app, strict.fakes, strict.id, "b1", "b1b"), "accepted", "allowUnprobed alone opens the gate");
});

test("rows 11 and 12 (§2.4, INV-33, P8): a vendor's first use is allowed and written to the installation's log — source default, global, idempotent — before the Turn that sends it; the delivery row names the row; a change of vendor, an endpoint a workspace file gave and a key nobody named are allowed the same way, with a notice", async t => {
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared() }, "bravo");
  const order = traced(w.store);
  fakes.observed.bravo = seen("openai");
  assert.equal(refusedAt(app, fakes, id, "b1 carries a1", "b1"), "accepted"); await app.wait(id);
  const b1 = app.read(id).runs.at(-1)!;
  assert.equal(b1.status, "completed"); assert.deepEqual(b1.sourceRunIds, [a1.id]);
  const rows = defaults(w.store);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.vendor, "openai"); assert.deepEqual(rows[0]!.scope, { kind: "global" }); assert.equal(rows[0]!.decision, "acknowledged");
  assert.ok(rows[0]!.commandId.startsWith("default-allow:openai:")); assert.equal(consentSourceOf(rows[0]!), "default");
  const delivery = w.store.relayDeliveries(id).find(row => row.runId === b1.id)!;
  assert.equal(delivery.consentLogSeq, rows[0]!.logSeq, "P8: the delivery names the log row");
  assert.deepEqual(order, ["log:" + rows[0]!.logSeq, "prepared"], "the row is written before run.context_prepared is committed");
  const prepared = eventOf(w.store, id, "run.context_prepared", b1.id)!.data;
  assert.deepEqual(prepared.consent, { via: "default", logSeq: rows[0]!.logSeq, first: true });
  // The second handoff to the same vendor writes nothing more and says it rests on that row.
  await to(app, id, "alpha", "to-a"); await accepted(app, fakes, id, "a2 newer", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
  const b2 = await accepted(app, fakes, id, "b2 carries a2", "b2");
  assert.equal(defaults(w.store).filter(row => row.vendor === "openai").length, 1, "idempotent: one row per vendor and policy");
  assert.deepEqual(eventOf(w.store, id, "run.context_prepared", b2.id)!.data.consent, { via: "global", logSeq: rows[0]!.logSeq });
  assert.equal(w.store.relayDeliveries(id).find(row => row.runId === b2.id)!.consentLogSeq, rows[0]!.logSeq);
  // Row 12: the Harness now runs another vendor (it changed its model): allowed, recorded, a row for the new key, the epoch's key follows.
  await to(app, id, "alpha", "to-a2"); await accepted(app, fakes, id, "a3 newer", "a3", { attach: "none" }); await to(app, id, "bravo", "to-b3");
  fakes.observed.bravo = seen("deepseek");
  const b3 = await accepted(app, fakes, id, "b3 carries a3 to another vendor", "b3");
  assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object");
  const changed = events(w.store, id).find(row => row.type === "relay.vendor_changed")!;
  assert.deepEqual({ ...changed.data }, { harnessId: "bravo", controlId: "bravo-acp", from: "openai", to: "deepseek", observedInRun: b3.id, allowed: true });
  assert.equal(relayOf(app.read(id), "bravo").consentKey, "deepseek");
  assert.deepEqual(defaults(w.store).map(row => row.vendor).sort(), ["deepseek", "openai"]);
  assert.equal(w.store.relayDeliveries(id).find(row => row.runId === b3.id)!.consentLogSeq, defaults(w.store).find(row => row.vendor === "deepseek")!.logSeq);
  // An endpoint a workspace file gave (the previous Harness could have written it) is allowed too, the layer shown with the first use.
  await to(app, id, "alpha", "to-a3"); await accepted(app, fakes, id, "a4 newer", "a4", { attach: "none" }); await to(app, id, "bravo", "to-b4");
  fakes.observed.bravo = endpoint("api.example.com", "workspace_file");
  const b4 = await accepted(app, fakes, id, "b4 carries a4 to a workspace file's endpoint", "b4");
  const noticed = eventOf(w.store, id, "run.context_prepared", b4.id)!.data;
  assert.deepEqual(noticed.consent, { via: "default", logSeq: defaults(w.store).find(row => row.vendor === "gateway:api.example.com")!.logSeq, first: true, layer: "workspace_file" });
  assert.ok(events(w.store, id).filter(row => row.type === "relay.vendor_changed").length === 2);
  // A key nobody named (the Driver cannot tell the vendor): unknown:<harness>, allowed likewise.
  const other = await fromAlpha(t, { bravo: declared() }, "bravo");
  const unnamed = await accepted(other.app, other.fakes, other.id, "b1 carries a1", "b1");
  assert.equal(typeof other.fakes.to("bravo").at(-1)!.turn, "object"); assert.equal(other.w.store.relayDeliveries(other.id).find(row => row.runId === unnamed.id)!.consentLogSeq, defaults(other.w.store)[0]!.logSeq);
  assert.equal(defaults(other.w.store)[0]!.vendor, "unknown:bravo");
});

test("row 11 (strict equivalence, P9): with relay.crossVendor=ask the default's rows are no consent: the handoff is asked for again, saying it is missing", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai");
  await accepted(app, fakes, id, "b1 carries a1", "b1");
  assert.equal(defaults(w.store).length, 1);
  await to(app, id, "alpha", "to-a"); await accepted(app, fakes, id, "a2 newer", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
  w.store.setPref("relay.crossVendor", "ask");
  assert.equal(refusedAt(app, fakes, id, "b2 would carry a2", "b2"), "RELAY_CONSENT_REQUIRED{missing}", "a row the default wrote is no consent the user gave");
  w.store.setPref("relay.crossVendor", "allow");
  assert.equal(refusedAt(app, fakes, id, "b2 would carry a2", "b2b"), "accepted");
});

test("row 13 (§2.4, P8): a consent the user withdrew is not overridden by the default: the history is not sent, the input goes alone and says so; allowing again sends it; an explicit attach is held to the withdrawal", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai");
  const order = traced(w.store);
  await accepted(app, fakes, id, "b1 carries a1", "b1");
  assert.equal(order.filter(row => row.startsWith("log:")).length, 1, "the first use wrote its row");
  w.store.appendRelayLog({ commandId: "user-revoke-openai", vendor: "openai" as VendorKey, scope: { kind: "global" }, decision: "revoked", categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 1 });
  await to(app, id, "alpha", "to-a"); const a2 = await accepted(app, fakes, id, "a2 newer", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
  const carriedBefore = fakes.carried("bravo");
  const b2 = await accepted(app, fakes, id, "b2 would carry a2", "b2");
  assert.ok(asTyped(fakes, "bravo", "b2 would carry a2"), "the history stays home"); assert.equal(fakes.carried("bravo"), carriedBefore);
  assert.deepEqual(decisionOf(w.store, id, b2), { kind: "alone", by: "policy", cause: "consent_revoked" });
  assert.equal(w.store.relayDeliveries(id).find(row => row.runId === b2.id), undefined, "P8: no delivery row for a vendor whose latest row is a revoke");
  assert.equal(order.filter(row => row.startsWith("log:")).length, 2, "no default row over a withdrawal: the log holds the first use's row and the user's withdrawal, nothing more");
  assert.equal(w.store.relayConsents().find(row => row.vendor === "openai")!.decision, "revoked", "the withdrawal is the latest row");
  const banner = app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention!;
  assert.equal(banner.cause, "consent_revoked"); assert.deepEqual(banner.options, ["acknowledge"]);
  // An explicit "附上交接单" is held to the user's own withdrawal: the 409 of the strict design.
  assert.equal(refusedAt(app, fakes, id, "b3 attaches", "b3", { attach: "full" }), "RELAY_CONSENT_REQUIRED{revoked}");
  // [重新允许]: the user allows again; the next input carries what is owed.
  w.store.appendRelayLog({ commandId: "user-allow-openai", vendor: "openai" as VendorKey, scope: { kind: "global" }, decision: "acknowledged", categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 2 });
  const b4 = await accepted(app, fakes, id, "b4 carries a2", "b4");
  assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object"); assert.ok(b4.sourceRunIds.includes(a2.id));
  assert.equal(w.store.relayDeliveries(id).find(row => row.runId === b4.id)!.consentLogSeq, w.store.relayConsents().find(row => row.commandId === "user-allow-openai")!.logSeq);
});

test("row 14 (§2.4, INV-36): a data directory in the workspace's reach does not stop a cross-vendor handoff — it is flagged for the workspace's banner; relay.dataRootInWorkspace=block brings the 409 back", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo", { isolated: false });
  fakes.observed.bravo = seen("openai");
  assert.equal(app.relayDataRootExposed(id), true);
  assert.equal(refusedAt(app, fakes, id, "b1 carries a1", "b1"), "accepted"); await app.wait(id);
  const b1 = app.read(id).runs.at(-1)!;
  assert.equal(b1.status, "completed"); assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object");
  assert.equal(eventOf(w.store, id, "run.context_prepared", b1.id)!.data.dataRootInWorkspace, true);
  await to(app, id, "alpha", "to-a"); await accepted(app, fakes, id, "a2 newer", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
  w.store.setPref("relay.dataRootInWorkspace", "block");
  assert.equal(refusedAt(app, fakes, id, "b2 would carry a2", "b2"), "RELAY_UNAVAILABLE{data_root_in_workspace}");
  assert.equal(refusedAt(app, fakes, id, "b2 alone", "b2-alone", { attach: "none" }), "accepted");
});

test("row 15 (§2.4, A15): a relay record that could not be recovered after a restart does not stop the input: it goes alone and the banner says to open a new native session; a native reset clears it; an explicit attach is refused as before", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai");
  await app.close(); w.store.close();
  // The mark a recovery leaves when a Session's relay rows could not be written (ADR-055 §9 S15), set on an open Session.
  const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
  try {
    const stored = JSON.parse(String(db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id)!.snapshot)) as SessionSnapshot;
    db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...stored, relayRecoveryFailed: stored.lastSeq }), id);
  } finally { db.close(); }
  w.store = new SqliteSessionStore(w.data, { recoverRelay });
  const next = w.runtime(fakes);
  assert.equal(next.read(id).relayRecoveryFailed !== undefined, true);
  const b1 = await accepted(next, fakes, id, "b1 would carry a1", "b1");
  assert.ok(asTyped(fakes, "bravo", "b1 would carry a1")); assert.deepEqual(decisionOf(w.store, id, b1), { kind: "alone", by: "policy", cause: "recovery_failed" });
  const banner = next.relayAttention(id).find(row => row.harnessId === "bravo")!.attention!;
  assert.equal(banner.cause, "recovery_failed"); assert.deepEqual(banner.options, ["new_native"]);
  assert.equal(refusedAt(next, fakes, id, "b2 attaches", "b2", { attach: "full" }), "RELAY_UNAVAILABLE{recovery_failed}", "an explicit attach is held to the failure");
  next.resetNative(id, "reset", next.read(id).epoch);
  const after = await accepted(next, fakes, id, "b3 carries after the reset", "b3");
  assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object"); assert.equal(after.relay?.kind, "packet");
});

test("row 16 (§2.4, D2): a window too small for the smallest packet does not stop the input — it goes alone, once per binding epoch said so, never repeating anything; a window that leaves less than the standard cap folds the packet to it", async t => {
  const small = await fromAlpha(t, { bravo: declared() }, "bravo");
  small.fakes.observed.bravo = seen("openai"); small.fakes.usage.bravo = { context: { used: 2000, size: 16_000 } };
  await accepted(small.app, small.fakes, small.id, "b0 alone, bravo's window is learnt", "b0", { attach: "none" });
  assert.equal(relayOf(small.app.read(small.id), "bravo").cache.contextSize, 16_000);
  for (const key of ["b1", "b2", "b3"]) {
    assert.equal(refusedAt(small.app, small.fakes, small.id, key + " would carry a1", key), "accepted"); await small.app.wait(small.id);
    const run = small.app.read(small.id).runs.at(-1)!;
    assert.equal(run.status, "completed"); assert.ok(asTyped(small.fakes, "bravo", key + " would carry a1"));
    assert.deepEqual(decisionOf(small.w.store, small.id, run), { kind: "alone", by: "policy", cause: "input_limit", reason: "min_packet" });
  }
  assert.equal(small.w.store.relayDeliveries(small.id).length, 0, "nothing repeated: no packet at all");
  const banner = small.app.relayAttention(small.id).find(row => row.harnessId === "bravo")!.attention!;
  assert.equal(banner.cause, "input_limit"); assert.deepEqual(banner.options, []);
  assert.equal(refusedAt(small.app, small.fakes, small.id, "b4 attaches", "b4", { attach: "full" }), "RELAY_INPUT_LIMIT{min_packet}", "an explicit attach is held to the limit");
  // A channel that is small but not too small: the packet is folded to what it leaves (the highest tier that fits), and goes.
  const medium = await fromAlpha(t, { bravo: declared({ maxInput: { unit: "chars", limit: 8000 } }) }, "bravo");
  medium.fakes.observed.bravo = seen("openai");
  const folded = await accepted(medium.app, medium.fakes, medium.id, "b1 carries a1, folded", "b1");
  assert.equal(typeof medium.fakes.to("bravo").at(-1)!.turn, "object"); assert.equal(folded.relay?.kind, "packet");
  assert.deepEqual(decisionOf(medium.w.store, medium.id, folded), { kind: "carry", by: "need" });
  assert.ok(medium.w.store.relayPackets(medium.id)[0]!.budget.clampedBy.includes("input_limit"), "the packet was folded to what the channel leaves");
});

test("row 17 (§2.5, D9): back on the Harness that held the conversation, the default continues its native session with a delta, whatever relay.returnPreference says; a new native session is only ever the user's (relay.native)", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai");
  const b1 = await accepted(app, fakes, id, "b1 carries a1", "b1");
  const alphaSession = fakes.to("alpha")[0]!.session;
  for (const preference of ["continue", "new_when_cold", "ask"]) {
    w.store.setPref("relay.returnPreference", preference);
    await to(app, id, "alpha", "to-a-" + preference);
    const a = await accepted(app, fakes, id, "a-" + preference + " continues", "a-" + preference);
    assert.equal(fakes.opens.filter(row => row.harnessId === "alpha").at(-1)!.checkpoint, alphaSession, preference + ": the original native session continued");
    assert.equal(fakes.to("alpha").at(-1)!.session, alphaSession);
    if (preference === "continue") { assert.equal(a.relay?.kind, "delta"); assert.deepEqual(a.sourceRunIds, [b1.id]); assert.equal(eventOf(w.store, id, "run.context_prepared", a.id)!.data.returnChoice, "continue"); }
    await to(app, id, "bravo", "to-b-" + preference); await accepted(app, fakes, id, "b-" + preference, "b-" + preference);
  }
  assert.equal(events(w.store, id).filter(row => row.type === "native.branch_requested").length, 0, "no new native session was ever chosen by the policy");
});

test("rows 18 and 19 (§2.5, C7): a command first after a handoff goes as typed and the packet waits for the next ordinary message; a reading that differs after the open is decided again in the same Run — never a failure", async t => {
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai");
  const compact = await accepted(app, fakes, id, "/compact", "c1");
  assert.ok(asTyped(fakes, "bravo", "/compact"), "as typed, nothing carried");
  assert.equal(eventOf(w.store, id, "run.native_command", compact.id)!.data.publicContextInjected, false);
  const b2 = await accepted(app, fakes, id, "b2 now carries", "b2");
  assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object"); assert.deepEqual(b2.sourceRunIds, [a1.id], "the packet came with the next ordinary message");
  // Row 19: the static reading and the catalog's differ, both ways.
  // /dyn: without a catalog a command whose arguments become a prompt (it may carry), by the catalog a plain command (it may not).
  const reading = (text: string, catalog: Parameters<typeof sharedClassify>[1], attachments: Parameters<typeof sharedClassify>[2]) =>
    text.startsWith("/dyn") ? (catalog === null ? { kind: "command" as const, name: "dyn", args: "", effect: "keep" as const, acceptsRelay: true as const } : { kind: "command" as const, name: "dyn", args: "", effect: "keep" as const })
    : text.startsWith("/notlisted") && catalog === null ? { kind: "command" as const, name: "notlisted", args: "", effect: "keep" as const } : sharedClassify(text, catalog, attachments);
  const s = await fromAlpha(t, { bravo: declared({ classify: reading }) }, "bravo");
  s.fakes.observed.bravo = seen("openai");
  // Command at admission, content at the open: it carries the packet; the Run completes.
  const content = await accepted(s.app, s.fakes, s.id, "/notlisted carries a1", "b1");
  assert.equal(typeof s.fakes.to("bravo").at(-1)!.turn, "object"); assert.deepEqual(content.sourceRunIds.length, 1);
  assert.deepEqual(decisionOf(s.w.store, s.id, content), { kind: "carry", by: "need", cause: "classification_changed" });
  // Content at admission, a command at the open, with facts owed: it goes as the command it is, the packet left owed.
  await to(s.app, s.id, "alpha", "to-a"); const a2 = await accepted(s.app, s.fakes, s.id, "a2 newer", "a2", { attach: "none" }); await to(s.app, s.id, "bravo", "to-b2");
  const command = await accepted(s.app, s.fakes, s.id, "/dyn now", "dyn");
  assert.ok(asTyped(s.fakes, "bravo", "/dyn now")); assert.deepEqual(decisionOf(s.w.store, s.id, command), { kind: "alone", by: "policy", cause: "classification_changed" });
  assert.notEqual(eventOf(s.w.store, s.id, "run.native_command", command.id), undefined, "decided again as a command");
  const next = await accepted(s.app, s.fakes, s.id, "b3 carries the newer fact", "b3");
  assert.ok(next.sourceRunIds.includes(a2.id)); assert.equal(typeof s.fakes.to("bravo").at(-1)!.turn, "object");
  // The strict design fails both with RELAY_PREPARE_FAILED{classification_changed} (G072-C04/C7 in relay-coordinator.test.ts).
});

test("row 20 (§2.5, INV-21, INV-29): what concerns the packet alone — the secrets that cannot be read, a row the Store refuses (quota, text), a log that cannot be written — never fails the Run: the input goes alone, relay state unchanged, and the next input tries again", async t => {
  const reasons: readonly (readonly [string, (s: Awaited<ReturnType<typeof fromAlpha>>) => () => void, string])[] = [
    ["redaction_failed", s => { s.fakes.secretsFail = true; return () => { s.fakes.secretsFail = false; }; }, "redaction_failed"],
    ["storage_quota", s => {
      const real = s.w.store.transact.bind(s.w.store);
      s.w.store.transact = (id, version, mutate) => real(id, version, state => { const next = mutate(state); if (next.relay?.packets?.length) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "storage_quota" }, "this conversation's relay packets reached their storage budget"); return next; });
      return () => { s.w.store.transact = real; };
    }, "storage_quota"],
    ["render", s => {
      const real = s.w.store.transact.bind(s.w.store);
      s.w.store.transact = (id, version, mutate) => real(id, version, state => { const next = mutate(state); if (next.relay?.packets?.length) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render" }, "the relay packet text is invalid"); return next; });
      return () => { s.w.store.transact = real; };
    }, "render"],
    ["consent_log_full", s => {
      const real = s.w.store.appendRelayLog.bind(s.w.store);
      s.w.store.appendRelayLog = () => { throw new RelayError({ code: "RELAY_UNAVAILABLE", reason: "consent_log_full" }, "the relay consent log is full"); };
      return () => { s.w.store.appendRelayLog = real; };
    }, "consent_log_full"],
  ];
  for (const [label, inject, reason] of reasons) {
    const s = await fromAlpha(t, { bravo: declared() }, "bravo");
    s.fakes.observed.bravo = seen("openai");
    const heal = inject(s);
    const b1 = await accepted(s.app, s.fakes, s.id, "b1 would carry a1 (" + label + ")", "b1");
    assert.ok(asTyped(s.fakes, "bravo", "b1 would carry a1 (" + label + ")"), label + ": as typed");
    assert.deepEqual(decisionOf(s.w.store, s.id, b1), { kind: "alone", by: "policy", cause: "prepare_failed", reason }, label);
    assert.deepEqual(relayOf(s.app.read(s.id), "bravo").sync, { kind: "fresh", basis: "new" }, label + ": relay state unchanged (INV-21): nothing pending, no mark");
    assert.equal(s.w.store.relayDeliveries(s.id).length, 0, label + ": no delivery row, no pending"); assert.equal(s.w.store.relayPackets(s.id).length, 0);
    heal();
    const b2 = await accepted(s.app, s.fakes, s.id, "b2 tries again (" + label + ")", "b2");
    assert.equal(typeof s.fakes.to("bravo").at(-1)!.turn, "object", label + ": the next input carries what is still owed"); assert.equal(b2.sourceRunIds.length, 1);
  }
  // A Turn the policy sent alone after its gates had passed is not held to the consent it would have rested on: withdrawn right
  // before dispatch, it still goes (nothing of the history leaves), as typed; the strict one that carries is the dispatch test's.
  const late = await fromAlpha(t, { bravo: declared() }, "bravo");
  late.fakes.observed.bravo = seen("openai"); late.fakes.secretsFail = true;
  late.fakes.onAuthorized = () => { late.w.store.appendRelayLog({ commandId: "user-revoke-late", vendor: "openai" as VendorKey, scope: { kind: "global" }, decision: "revoked", categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 1 }); late.fakes.onAuthorized = null; };
  const goes = await accepted(late.app, late.fakes, late.id, "b1 alone, consent withdrawn at the last moment", "b1");
  assert.ok(asTyped(late.fakes, "bravo", "b1 alone, consent withdrawn at the last moment")); assert.equal(decisionOf(late.w.store, late.id, goes)?.cause, "prepare_failed");
  // The strict design fails the Run (G070-MVP N3 and the like); an explicit attach does too, in the default world.
  const explicit = await fromAlpha(t, { bravo: declared() }, "bravo");
  explicit.fakes.observed.bravo = seen("openai"); explicit.fakes.secretsFail = true;
  const failed = await turn(explicit.app, explicit.id, "b1 attaches", "b1", { attach: "full" });
  assert.equal(failed.status, "failed"); assert.equal(failed.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(failed.timing?.dispatchedAt, undefined);
});

test("P10 (§0 rule 3): what the user chose is not rewritten by the policy — attach full or resend is carried as the user's own choice and fails when it cannot be; whenUnsure=ask and the strict preferences bring the questions back", async t => {
  // A Driver that reports a recorded input as an event (live) but cannot be asked: its unconfirmed packets stay so, and no admission check can settle them.
  const { w, fakes, app, id } = await pendingSpent(t, { verify: "none", live: "recorded_event" });
  // The user's resend of a pending packet is theirs: it goes (manualResends), never turned into alone.
  const user = await accepted(app, fakes, id, "b3 sends it again", "b3", { resend: true });
  assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object"); assert.deepEqual(decisionOf(w.store, id, user), { kind: "carry", by: "user" });
  const sync = syncOf(app, id, "bravo"); assert.ok(sync.kind === "pending" && sync.manualResends === 1);
  // whenUnsure=ask: the question the strict design asked, at admission, no Run.
  w.store.setPref("relay.whenUnsure", "ask");
  assert.equal(refusedAt(app, fakes, id, "b4 would resend", "b4"), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
  w.store.setPref("relay.whenUnsure", "auto");
  assert.equal(refusedAt(app, fakes, id, "b4 is settled by the policy", "b4b"), "accepted"); await app.wait(id);
  // The strict world, all four preferences: the same case is asked.
  strictRelay(w.store);
  assert.equal(refusedAt(app, fakes, id, "b5", "b5"), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
});
