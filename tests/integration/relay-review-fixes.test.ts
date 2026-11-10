import assert from "node:assert/strict";
import { test } from "node:test";
import { consentSourceOf, relayDecisionOf, type RelayDecision, type VendorKey } from "../../src/contracts/relay.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import type { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import type { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { RelayError } from "../../src/contracts/relay.js";
import { CHECKING, Fakes, declared, eventOf, events, fromAlpha, refusedAt, relayOf, seen, to, turn, world } from "../fixtures/relay-fakes.js";

// The independent reviews' findings on G072 and the permissive defaults (docs/proposals/relay/permissive-defaults.md; the review
// of 072075f): each test is one finding reproduced on the formal SessionRuntime, a real SqliteSessionStore and fixture Harnesses
// (tests/fixtures/relay-fakes.ts), written to fail before its fix. Nothing here runs a Harness.

function decisionOf(store: SqliteSessionStore, id: SessionId, run: PublicRun): RelayDecision | null {
  const prepared = eventOf(store, id, "run.context_prepared", run.id);
  return prepared === undefined ? null : relayDecisionOf(prepared.data);
}
const syncOf = (app: SessionRuntime, id: SessionId, harnessId: string) => relayOf(app.read(id), harnessId).sync;
/** A send the relay must not stop: its Run completes. */
async function accepted(app: SessionRuntime, id: SessionId, text: string, key: string, relay?: Parameters<typeof turn>[4]): Promise<PublicRun> {
  const run = await turn(app, id, text, key, relay);
  assert.equal(run.status, "completed", text + ": " + (run.error?.code ?? ""));
  return run;
}
const asTyped = (fakes: { to(harnessId: string): readonly { readonly text: string; readonly turn: unknown }[] }, harnessId: string, text: string): boolean => {
  const last = fakes.to(harnessId).at(-1)!; return typeof last.turn === "string" && last.text === text;
};
const global = (vendor: string, decision: "acknowledged" | "revoked", commandId: string) => ({ commandId, vendor: vendor as VendorKey, scope: { kind: "global" as const }, decision, categories: ["user_text" as const], policyVersion: "relay/1" as const, authKind: null, decidedAt: 1 });
const defaults = (store: SqliteSessionStore) => store.relayConsents().filter(row => consentSourceOf(row) === "default");

// ---------------------------------------------------------------------------------------------------------------------
// I1 — a withdrawal holds when the read of the vendor fails
// ---------------------------------------------------------------------------------------------------------------------

test("G072-RV01 (review I1, INV-33) a vendor the user withdrew is not given the history because the read of its vendor failed — the epoch's key, what the binding last saw and what its lineage last saw still stand for it, a failed read does not overwrite them, and it makes no vendor change", async t => {
  for (const mode of ["answers nothing", "fails"] as const) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
    fakes.observed.bravo = seen("openai");
    await accepted(app, id, "b1 carries a1", "b1");
    assert.equal(relayOf(app.read(id), "bravo").consentKey, "openai"); assert.equal(relayOf(app.read(id), "bravo").vendorObserved?.authKind, "openai");
    w.store.appendRelayLog(global("openai", "revoked", "user-revoke-openai"));
    await to(app, id, "alpha", "to-a"); const a2 = await accepted(app, id, "a2 SECRET-FACT newer", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
    // Control: with the read intact the withdrawal holds.
    const b2 = await accepted(app, id, "b2 would carry a2", "b2");
    assert.deepEqual(decisionOf(w.store, id, b2), { kind: "alone", by: "policy", cause: "consent_revoked" });
    // The read of the vendor now fails: the Driver cannot tell, which says nothing of a change.
    if (mode === "fails") fakes.observeFails.add("bravo"); else fakes.observed.bravo = null;
    const carried = fakes.carried("bravo"), rows = w.store.relayDeliveries(id).length;
    const b3 = await accepted(app, id, "b3 would carry a2", "b3");
    assert.equal(fakes.carried("bravo"), carried, mode + ": nothing of the history went to a vendor the user withdrew");
    assert.ok(asTyped(fakes, "bravo", "b3 would carry a2"), mode + ": as typed");
    assert.equal(fakes.to("bravo").every(row => !row.text.includes("SECRET-FACT")), true, mode + ": a2's text reached no prompt");
    assert.deepEqual(decisionOf(w.store, id, b3), { kind: "alone", by: "policy", cause: "consent_revoked" });
    assert.equal(w.store.relayDeliveries(id).length, rows, mode + ": no delivery row");
    assert.deepEqual(defaults(w.store).filter(row => row.vendor === "unknown:bravo"), [], mode + ": no allowance was traced for a key nobody saw");
    const kept = relayOf(app.read(id), "bravo");
    assert.equal(kept.vendorObserved?.authKind, "openai", mode + ": the failed read did not overwrite what the binding last saw"); assert.equal(kept.consentKey, "openai", mode + ": nor the epoch's key");
    assert.equal(events(w.store, id).filter(row => row.type === "relay.vendor_changed").length, 0, mode + ": a read that told nothing is no change of vendor");
    // An explicit attach is held to the withdrawal as well: refused, nothing is sent.
    assert.equal(refusedAt(app, fakes, id, "b4 attaches", "b4", { attach: "full" }), "RELAY_CONSENT_REQUIRED{revoked}");
    assert.equal(fakes.carried("bravo"), carried);
    // The user allows the vendor again: with the read still failing the history goes, recorded for the honest unknown key.
    w.store.appendRelayLog(global("openai", "acknowledged", "user-allow-openai"));
    const b5 = await accepted(app, id, "b5 carries a2", "b5");
    assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object", mode + ": allowed again, it goes"); assert.ok(b5.sourceRunIds.includes(a2.id));
    assert.equal(w.store.relayPackets(id).at(-1)!.target.vendor, "unknown:bravo", mode + ": the packet is recorded for the vendor nobody saw, not for a guess");
    assert.equal(relayOf(app.read(id), "bravo").consentKey, "openai", mode + ": the epoch's key stands");
    assert.equal(events(w.store, id).filter(row => row.type === "relay.vendor_changed").length, 0);
  }
  // The limit: a Harness whose vendor was never read leaves nothing to hold a withdrawal against (the first handoff of a binding the
  // Driver cannot read): the history goes, recorded for unknown:<harness>.
  const first = await fromAlpha(t, { bravo: declared() }, "bravo");
  first.fakes.observed.bravo = null; first.w.store.appendRelayLog(global("openai", "revoked", "user-revoke-openai"));
  await accepted(first.app, first.id, "b1 carries a1", "b1");
  assert.equal(typeof first.fakes.to("bravo").at(-1)!.turn, "object"); assert.equal(first.w.store.relayPackets(first.id)[0]!.target.vendor, "unknown:bravo");
});

// ---------------------------------------------------------------------------------------------------------------------
// I2 and I6 — a clear is confirmed by evidence; the gates that stay on
// ---------------------------------------------------------------------------------------------------------------------

/** A gateway-style Driver (OpenClaw's, Hermes') that concludes a clear from the native side's own signal and whose checks answer nothing. */
const SIGNAL = { verify: "after_turn", successProvesRecorded: false, lateDelivery: true, execution: "gateway", compactionEvidence: "none" } as const;

test("G072-RV02 (review I2, B7) a clear an unprobed Driver concludes from the native side's own signal is a clear the relay cannot confirm: the floor and the epoch stay, the user's [确认已清空] or a check that sees the history settles it; a probed Driver's report, and a synthesized clear that gave the native session up, still confirm at once", async t => {
  for (const probed of [false, true]) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ ...SIGNAL, probed }) }, "bravo");
    fakes.observed.bravo = seen("openai");
    fakes.script = (harnessId, input) => harnessId === "bravo" ? (input.startsWith("/clear") ? { result: "unrecorded", cleared: true } : { result: "unrecorded" }) : {};
    await accepted(app, id, "b1 carries a1", "b1");   // the check after the Turn finds the packet in the history: synced on its mark
    assert.equal(syncOf(app, id, "bravo").kind, "synced");
    fakes.readable = false;   // from here no check can tell: only the Driver's own report of the clear is left
    const before = relayOf(app.read(id), "bravo");
    const cleared = await accepted(app, id, "/clear", "c1");
    const after = relayOf(app.read(id), "bravo");
    assert.deepEqual(cleared.relay?.continuity, { kind: "native_resume" });
    if (probed) {
      assert.deepEqual(after.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(after.nativeEpoch, before.nativeEpoch + 1); assert.ok(after.epochFloor > before.epochFloor);
      assert.equal(app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention, null);
    } else {
      assert.ok(after.sync.kind === "suspect" && after.sync.cause === "clear_unconfirmed" && after.sync.floorCandidate !== null, JSON.stringify(after.sync));
      assert.equal(after.nativeEpoch, before.nativeEpoch, "no epoch raised on a report nothing verified"); assert.equal(after.epochFloor, before.epochFloor, "no floor raised");
      const banner = app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention!;
      assert.equal(banner.cause, "clear_unconfirmed"); assert.ok(banner.options.includes("clear_confirmed"));
      // The user's [确认已清空] is the other way: it raises the floor and the epoch at the clear's seq.
      const confirmed = await accepted(app, id, "b2 after the user confirmed the clear", "b2", { clearConfirmed: true });
      assert.equal(relayOf(app.read(id), "bravo").nativeEpoch, before.nativeEpoch + 1); assert.ok(relayOf(app.read(id), "bravo").epochFloor > before.epochFloor);
      assert.ok(asTyped(fakes, "bravo", "b2 after the user confirmed the clear") && decisionOf(w.store, id, confirmed) === null);
    }
  }
  // A check that sees the history settles it without the user: the same unprobed Driver, whose check after the Turn reads an empty history.
  const seeing = await fromAlpha(t, { bravo: declared({ ...SIGNAL, probed: false, compactionEvidence: "event" }) }, "bravo");
  seeing.fakes.observed.bravo = seen("openai");
  seeing.fakes.script = (harnessId, input) => harnessId === "bravo" ? (input.startsWith("/clear") ? { result: "unrecorded", cleared: true } : { result: "unrecorded" }) : {};
  await accepted(seeing.app, seeing.id, "b1 carries a1", "b1");
  const was = relayOf(seeing.app.read(seeing.id), "bravo");
  const seen1 = await accepted(seeing.app, seeing.id, "/clear", "c1");
  assert.equal(relayOf(seeing.app.read(seeing.id), "bravo").nativeEpoch, was.nativeEpoch + 1, "the check saw the empty history and confirmed the clear");
  assert.equal(eventOf(seeing.w.store, seeing.id, "relay.verified", seen1.id)?.data.result, "cleared", "by evidence, not by the Driver's report");
  // A synthesized clear (Claude Code's: the Hub's own Driver gives the native session up) is certain once the Turn is confirmed, probed or not.
  const synthesized = await fromAlpha(t, { bravo: declared({ probed: false }) }, "bravo");
  synthesized.fakes.observed.bravo = seen("openai");
  synthesized.fakes.script = (harnessId, input) => harnessId === "bravo" && input.startsWith("/clear") ? { result: "unrecorded", cleared: { replaced: { checkpoint: null } } } : {};
  await accepted(synthesized.app, synthesized.id, "b1 carries a1", "b1");
  const prior = relayOf(synthesized.app.read(synthesized.id), "bravo");
  await accepted(synthesized.app, synthesized.id, "/clear", "c1");
  const next = relayOf(synthesized.app.read(synthesized.id), "bravo");
  assert.equal(next.nativeEpoch, prior.nativeEpoch + 1); assert.ok(next.epochFloor > prior.epochFloor); assert.deepEqual(next.sync, { kind: "fresh", basis: "user_cleared" });
  assert.equal(synthesized.app.read(synthesized.id).nativeBindings!.filter(row => row.harnessId === "bravo" && row.status === "archived").length, 1, "the old native session was given up");
});

test("G072-RV03 (review I6, D6, M13) the original session of a Turn that ended unknown is continued only for a Driver whose probes proved it (a process Driver, probed): an unprobed one leaves the conversation blocked and the packet pending", async t => {
  for (const probed of [false, true]) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ ...CHECKING, probed }) }, "bravo");
    fakes.observed.bravo = seen("openai");
    fakes.script = (harnessId, input) => harnessId === "bravo" && input === "b1 lost but written" ? { result: "lost" } : {};
    const lost = await turn(app, id, "b1 lost but written", "b1");
    assert.equal(lost.status, "unknown"); assert.equal(app.read(id).status, "blocked");
    const binding = syncOf(app, id, "bravo"), ended = eventOf(w.store, id, "run.ended", lost.id)!;
    if (probed) {
      assert.ok(binding.kind === "suspect" && binding.cause === "unknown_turn" && binding.carried !== null, JSON.stringify(binding));
      assert.equal(ended.data.continued, true);
    } else {
      assert.equal(binding.kind, "pending", "the packet stays pending: nothing proved the original session may be continued");
      assert.equal(ended.data.continued, undefined);
    }
  }
});

test("G072-RV04 (review I6, M15) a Driver with no compaction evidence writes the constant cursor at delivery only when its probes proved it never compacts: an unprobed one writes none, and the clear check's rule 4 (every marker of the chain absent) then settles nothing", async t => {
  for (const probed of [false, true]) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ probed, verify: "on_next_open", compactionEvidence: "none" }) }, "bravo");
    fakes.observed.bravo = seen("openai");
    await accepted(app, id, "b1 carries a1", "b1");
    assert.deepEqual(w.store.relayDeliveries(id)[0]!.compactionAtDelivery, probed ? { count: 0, digest: null } : null, "probed " + probed);
    assert.equal(syncOf(app, id, "bravo").kind, "synced", "recorded by the completed Turn");
    // An unconfirmed clear (the command ran, nothing confirmed it) wipes the history; then something typed in the original program: the
    // history is not empty (rule 1 does not apply) and the packet's marker is absent.
    await accepted(app, id, "/clear", "c1");
    const doubt = syncOf(app, id, "bravo");
    assert.ok(doubt.kind === "suspect" && doubt.cause === "clear_unconfirmed");
    fakes.history.get(fakes.to("bravo")[0]!.session)!.push("typed in the original program");
    const before = relayOf(app.read(id), "bravo");
    await accepted(app, id, "b2 after the clear", "b2");
    const after = relayOf(app.read(id), "bravo");
    if (probed) assert.equal(after.nativeEpoch, before.nativeEpoch + 1, "a compaction is ruled out: the absent marker proves the clear");
    else { assert.equal(after.nativeEpoch, before.nativeEpoch, "a Driver that cannot tell a folded marker from a cleared one confirms nothing"); assert.equal(after.epochFloor, before.epochFloor); }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// I4 — a packet sent again for newer facts that never left
// ---------------------------------------------------------------------------------------------------------------------

test("G072-RV05 (review I4, m9) a packet sent again for newer facts (grown) that never left goes back to waiting for the packet it superseded — at the Turn's settlement and at a recovery alike; one whose predecessor's Run cannot be told still goes for newer facts, once, instead of leaving the binding alone for good", async t => {
  const make = async () => {
    const s = await fromAlpha(t, { bravo: declared({ verify: "none", live: "recorded_event", successProvesRecorded: false }) }, "bravo");
    s.fakes.observed.bravo = seen("openai");
    s.fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
    await accepted(s.app, s.id, "b1 carries a1", "b1"); await accepted(s.app, s.id, "b2 resends", "b2"); await accepted(s.app, s.id, "b3 alone", "b3");
    const spent = syncOf(s.app, s.id, "bravo");
    assert.ok(spent.kind === "pending" && spent.autoResends === 1, "the packet and its automatic resend are spent: " + JSON.stringify(spent));
    await to(s.app, s.id, "alpha", "to-a"); await accepted(s.app, s.id, "a2 newer", "a2", { attach: "none" }); await to(s.app, s.id, "bravo", "to-b2");
    return { ...s, spent };
  };
  // The grown packet's Turn ends before it is dispatched: at its settlement, and as a recovery would find it.
  const { w, fakes, app, id, spent } = await make();
  let snapshot: { state: ReturnType<typeof app.read>; rows: ReturnType<typeof w.store.relayDeliveries>; packets: ReturnType<typeof w.store.relayPackets> } | null = null;
  fakes.onAuthorized = () => { snapshot = { state: app.read(id), rows: w.store.relayDeliveries(id), packets: w.store.relayPackets(id) }; fakes.onAuthorized = null; throw new Error("the Turn ends before dispatch"); };
  const b4 = await turn(app, id, "b4 grown", "b4");
  assert.equal(b4.timing?.dispatchedAt, undefined, "never dispatched"); assert.deepEqual(decisionOf(w.store, id, b4), { kind: "carry", by: "policy", cause: "delivery_unconfirmed" });
  const settled = syncOf(app, id, "bravo");
  assert.ok(settled.kind === "pending" && spent.kind === "pending" && settled.packetId === spent.packetId, "settlement: waiting for the packet the grown one superseded");
  const { recoverRelay } = await import("../../src/contexts/session/domain/relay/recover.js");
  const recovery = recoverRelay(snapshot!.state, snapshot!.rows, snapshot!.packets);
  const recovered = recovery!.next.nativeBindings!.find(row => row.harnessId === "bravo" && row.status !== "archived")!.relay!.sync;
  assert.ok(recovered.kind === "pending" && recovered.packetId === settled.packetId && recovered.autoResends === settled.autoResends && recovered.manualResends === settled.manualResends,
    "recovery agrees with the settlement: " + JSON.stringify(recovered) + " against " + JSON.stringify(settled));
  assert.deepEqual(recovery!.deliveries.map(row => row.outcome.kind + "/" + (row.outcome as { reason?: string }).reason), ["not_recorded/never_dispatched"]);
  // m9: the delivery row of the pending packet is gone from what the decision reads (damaged data): a plain resend cannot link its row
  // to what it supersedes — the policy sends alone — but a packet for newer facts still goes, once, and the binding is not alone for good.
  const lost = await make();
  // The Runtime finds the Run that carried a pending packet by its row, else by a Run whose relay names it (pendingRunOf); damaged data
  // can leave neither. The seam is private, so the test reaches in for it.
  (lost.app as unknown as { pendingRunOf: () => null }).pendingRunOf = () => null;
  const grown = await accepted(lost.app, lost.id, "b4 grown, the Run of the pending packet is unknown", "b4");
  assert.equal(typeof lost.fakes.to("bravo").at(-1)!.turn, "object", "the newer facts go, with everything owed from the prior"); assert.deepEqual(decisionOf(lost.w.store, lost.id, grown), { kind: "carry", by: "policy", cause: "delivery_unconfirmed" });
  assert.equal(grown.sourceRunIds.length, 2, "a1 and a2");
  const after = syncOf(lost.app, lost.id, "bravo");
  assert.ok(after.kind === "pending" && after.autoResends === 0, JSON.stringify(after));
  assert.equal(eventOf(lost.w.store, lost.id, "run.context_prepared", grown.id)!.data.resendOf ?? null, null, "no Run to link");
  // Without newer facts, the same state sends alone (no resend that could not name what it supersedes).
  const b5 = await accepted(lost.app, lost.id, "b5 as typed", "b5");
  assert.deepEqual(decisionOf(lost.w.store, lost.id, b5), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }); assert.ok(asTyped(lost.fakes, "bravo", "b5 as typed"));
});

// ---------------------------------------------------------------------------------------------------------------------
// I3 — a Driver that declares nothing cannot say what its native side reads as a command
// ---------------------------------------------------------------------------------------------------------------------

test("G072-RV06 (review I3, B9) an input that starts with a slash, sent to a Driver that declares nothing (WorkBuddy, Pi), is read as a command whatever its catalog lists, or whether it has one: it goes as typed, carries nothing, and the packet waits for the next ordinary message", async t => {
  for (const catalog of [true, false]) {
    const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: null }, "bravo");
    if (!catalog) {
      const prepare = fakes.prepare.bind(fakes);
      fakes.prepare = async (selected, configuration) => { const prepared = await prepare(selected, configuration); if (selected.harnessId === "bravo") delete prepared.control.models; return prepared; };
    }
    const label = catalog ? "a catalog that does not list it" : "no catalog";
    const command = await accepted(app, id, "/unlisted do something", "b1");
    assert.ok(asTyped(fakes, "bravo", "/unlisted do something"), label + ": the native side gets the slash first and the words as typed");
    assert.deepEqual(command.relay?.continuity, { kind: "native_resume" }); assert.equal(command.relay?.packetId, null);
    assert.notEqual(eventOf(w.store, id, "run.native_command", command.id), undefined, label + ": read as a command, said so");
    assert.equal(eventOf(w.store, id, "run.native_command", command.id)!.data.publicContextInjected, false);
    assert.equal(w.store.relayDeliveries(id).length, 0, label + ": no packet was made");
    // The packet comes with the next ordinary message, and a slash in the middle of a message is no command.
    const next = await accepted(app, id, "b2 an ordinary message with /a/path in it", "b2");
    assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object", label + ": the packet came with the next ordinary message"); assert.deepEqual(next.sourceRunIds, [a1.id]);
    // Whitespace before the slash: the first character is not a slash, so it is words.
    await to(app, id, "alpha", "to-a"); await accepted(app, id, "a2 newer", "a2", { attach: "none" }); await to(app, id, "bravo", "to-b2");
    await accepted(app, id, " /not a command", "b3");
    assert.equal(typeof fakes.to("bravo").at(-1)!.turn, "object", label + ": a space first makes it words");
  }
  // The strict setting asks an ordinary input what it asks of a Driver that declares nothing (RELAY_TARGET_UNVERIFIED), but never a command first.
  const strict = await fromAlpha(t, { bravo: null }, "bravo", { strict: true });
  assert.equal(refusedAt(strict.app, strict.fakes, strict.id, "/unlisted do something", "k1"), "accepted", "a command is never stopped by the relay"); await strict.app.wait(strict.id);
  assert.equal(refusedAt(strict.app, strict.fakes, strict.id, "b2 an ordinary message", "k2"), "RELAY_TARGET_UNVERIFIED{undeclared}");
});

// ---------------------------------------------------------------------------------------------------------------------
// I7 — the native title
// ---------------------------------------------------------------------------------------------------------------------

test("G072-RV07 (review I7, M23) a native session a handoff opened is named once, after the Turn that carries the packet is committed and before it is dispatched — not when the Turn goes alone after all (the consent log cannot be written, the vendor was withdrawn), not for a session no handoff opened (a conversation's first Turn, a second handoff to the same native session) — and the name hides the secrets of every Harness of the conversation", async t => {
  const titled = { bravo: declared({ title: "set" }) };
  // Named: once, between the packet's commit and its dispatch, with the conversation's first words.
  const named = await fromAlpha(t, titled, "bravo");
  named.fakes.observed.bravo = seen("openai");
  const b1 = await accepted(named.app, named.id, "b1 carries a1", "b1");
  assert.deepEqual(named.fakes.titles, [{ harnessId: "bravo", title: "a1 a fact on alpha" }]);
  const log = events(named.w.store, named.id), at = (type: string) => log.find(row => row.type === type && row.data.runId === b1.id)!;
  assert.ok(at("run.context_prepared").seq < at("relay.title_set").seq && at("relay.title_set").seq < at("run.dispatched").seq, "after the commit, before the dispatch");
  assert.equal(at("relay.title_set").data.result, "set");
  // M23: the second handoff goes to the same native session and names nothing.
  await to(named.app, named.id, "alpha", "to-a"); await accepted(named.app, named.id, "a2 newer", "a2", { attach: "none" }); await to(named.app, named.id, "bravo", "to-b2");
  await accepted(named.app, named.id, "b2 carries a2", "b2");
  assert.equal(typeof named.fakes.to("bravo").at(-1)!.turn, "object"); assert.equal(named.fakes.titles.length, 1, "a native session already named by its handoff is not named again");
  // Nor a conversation's own first Turn, which no handoff opened.
  const own = world(t), fakes = new Fakes({ bravo: declared({ title: "set" }) }), app = own.runtime(fakes);
  const id = (await app.create(own.configuration, { harnessId: "bravo" }, "create")).id;
  await accepted(app, id, "b0 the very first words", "b0"); assert.deepEqual(fakes.titles, []);
  // The Turn goes alone after all: nothing is named (R2: the log cannot be written; R2b: the vendor was withdrawn).
  const full = await fromAlpha(t, titled, "bravo");
  full.fakes.observed.bravo = seen("openai");
  const append = full.w.store.appendRelayLog.bind(full.w.store);
  full.w.store.appendRelayLog = () => { throw new RelayError({ code: "RELAY_UNAVAILABLE", reason: "consent_log_full" }, "the relay consent log is full"); };
  const logFull = await accepted(full.app, full.id, "b1 would carry a1", "b1");
  assert.deepEqual(decisionOf(full.w.store, full.id, logFull), { kind: "alone", by: "policy", cause: "prepare_failed", reason: "consent_log_full" });
  assert.deepEqual(full.fakes.titles, [], "the log could not be written: the Turn went alone and the native session was not named");
  assert.equal(eventOf(full.w.store, full.id, "relay.title_set", logFull.id), undefined);
  full.w.store.appendRelayLog = append;
  const revoked = await fromAlpha(t, titled, "bravo");
  revoked.fakes.observed.bravo = seen("openai"); revoked.w.store.appendRelayLog(global("openai", "revoked", "user-revoke-openai"));
  const alone = await accepted(revoked.app, revoked.id, "b1 would carry a1", "b1");
  assert.deepEqual(decisionOf(revoked.w.store, revoked.id, alone), { kind: "alone", by: "policy", cause: "consent_revoked" });
  assert.deepEqual(revoked.fakes.titles, [], "a withheld history names no session after its first words");
  // The name is the first words unless they hold a secret any Harness of the conversation holds: then it is "新对话".
  const secret = "mG4xQ7pL2vN8zT5wR1yK9";
  const hidden = world(t), many = new Fakes({ alpha: declared(), bravo: declared({ title: "set" }) }), keeper = hidden.runtime(many);
  many.observed.alpha = seen("anthropic"); many.observed.bravo = seen("openai"); many.secrets.push(secret);
  const sid = (await keeper.create(hidden.configuration, { harnessId: "alpha" }, "create")).id;
  await accepted(keeper, sid, "a1 the key is " + secret + " ok", "a1"); await to(keeper, sid, "bravo", "to-b");
  await accepted(keeper, sid, "b1 carries a1", "b1");
  assert.deepEqual(many.titles, [{ harnessId: "bravo", title: "新对话" }], "the secret of another Harness is not in the name");
});

// ---------------------------------------------------------------------------------------------------------------------
// I5 and M26 — attention is the state the conversation is in now
// ---------------------------------------------------------------------------------------------------------------------

const banner = (app: SessionRuntime, id: SessionId, harnessId = "bravo") => app.relayAttention(id).find(row => row.harnessId === harnessId)?.attention ?? null;

test("G072-RV08 (review I5, M26) what a binding asks is worked out from the state it is in now, not from its latest Turn: a withdrawal's banner stays through a command Turn, goes the moment the user allows the vendor again (no Turn needed) and shows anew for a later withdrawal; a window too small for the smallest packet is known before any Turn is sent alone and ends when the window is learnt to be larger; the starting history of a branch counts as owed; the Turns a native session holds since a clear confirmed after the fact are not owed", async t => {
  // A1 and R4: the withdrawal.
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai");
  await accepted(app, id, "b0 on bravo, as typed", "b0", { attach: "none" });
  assert.equal(banner(app, id), null, "the vendor is allowed: nothing to say");
  w.store.appendRelayLog(global("openai", "revoked", "user-revoke-1"));
  const first = banner(app, id)!;
  assert.equal(first.cause, "consent_revoked", "known before any Turn is sent alone"); assert.deepEqual(first.options, ["acknowledge"]); assert.equal(first.counts.runs, 1);
  const alone = await accepted(app, id, "b1 would carry a1", "b1");
  assert.deepEqual(decisionOf(w.store, id, alone), { kind: "alone", by: "policy", cause: "consent_revoked" });
  await accepted(app, id, "/compact", "c1");
  assert.deepEqual(banner(app, id), first, "a command Turn changes nothing: the cause stands, the banner too, with the same key");
  w.store.appendRelayLog(global("openai", "acknowledged", "user-allow-1"));
  assert.equal(banner(app, id), null, "allowed again: gone at once, not at the next Turn");
  w.store.appendRelayLog(global("openai", "revoked", "user-revoke-2"));
  const later = banner(app, id)!;
  assert.equal(later.cause, "consent_revoked"); assert.notEqual(later.key, first.key, "a withdrawal made later is another episode: a banner closed for the first shows again");
  // A2: the window.
  const small = await fromAlpha(t, { bravo: declared() }, "bravo");
  small.fakes.observed.bravo = seen("openai"); small.fakes.usage.bravo = { context: { used: 2000, size: 16_000 } };
  await accepted(small.app, small.id, "b0 alone, bravo's window is learnt", "b0", { attach: "none" });
  const tight = banner(small.app, small.id)!;
  assert.equal(tight.cause, "input_limit"); assert.deepEqual(tight.options, []);
  small.fakes.usage.bravo = { context: { used: 2000, size: 400_000 } };
  await accepted(small.app, small.id, "b1 alone, the window is learnt to be larger", "b1", { attach: "none" });
  assert.equal(banner(small.app, small.id), null, "the window grew: the banner ended with its cause");
  // A3: a branch owes the history it started from, and the Turns of it count.
  const branchOf = await fromAlpha(t, { bravo: declared() }, "bravo");
  branchOf.fakes.observed.bravo = seen("openai");
  const branch = branchOf.app.fork(branchOf.id, "fork-1"); await branchOf.app.wait(branch.id).catch(() => {});
  branchOf.w.store.appendRelayLog(global("openai", "revoked", "user-revoke-1"));
  const onBranch = await accepted(branchOf.app, branch.id, "b1 on the branch would carry the quoted history", "b1");
  assert.deepEqual(decisionOf(branchOf.w.store, branch.id, onBranch), { kind: "alone", by: "policy", cause: "consent_revoked" });
  const quoted = banner(branchOf.app, branch.id)!;
  assert.equal(quoted.cause, "consent_revoked"); assert.ok(quoted.counts.runs >= 1, "the quoted history is owed: " + JSON.stringify(quoted.counts));
  // M26: bravo's own Turns since a clear the user confirmed after the fact are in the history the clear left, so they are not owed. The
  // confirming Turn ends before its dispatch, so the binding stands fresh at the new epoch with no mark: what it owes is read from the floor.
  const held = await fromAlpha(t, { bravo: declared({ ...SIGNAL, probed: false }) }, "bravo");
  held.fakes.observed.bravo = seen("openai");
  held.fakes.script = (harnessId, input) => harnessId === "bravo" ? (input.startsWith("/clear") ? { result: "unrecorded", cleared: true } : { result: "unrecorded" }) : {};
  await accepted(held.app, held.id, "b1 carries a1", "b1");
  held.fakes.readable = false;
  await accepted(held.app, held.id, "/clear", "c1");
  await accepted(held.app, held.id, "b2 after the unconfirmed clear", "b2"); await accepted(held.app, held.id, "b3 after the unconfirmed clear", "b3");
  held.fakes.onAuthorized = () => { held.fakes.onAuthorized = null; throw new Error("the Turn ends before dispatch"); };
  const confirming = await turn(held.app, held.id, "b4 the user confirms the clear", "b4", { clearConfirmed: true });
  assert.equal(confirming.timing?.dispatchedAt, undefined, "never dispatched");
  const fresh = relayOf(held.app.read(held.id), "bravo");
  assert.equal(fresh.nativeEpoch, 2, "the confirmation was committed with the Turn's authorization"); assert.deepEqual(fresh.sync, { kind: "fresh", basis: "user_cleared" });
  await to(held.app, held.id, "alpha", "to-a"); await accepted(held.app, held.id, "a2 newer", "a2", { attach: "none" }); await to(held.app, held.id, "bravo", "to-b");
  held.w.store.appendRelayLog(global("openai", "revoked", "user-revoke-1"));
  const waiting = banner(held.app, held.id)!;
  assert.equal(waiting.cause, "consent_revoked"); assert.equal(waiting.counts.runs, 1, "only a2 is owed: b2 and b3 ran on this native session in the epoch the clear ended, they are held (" + JSON.stringify(waiting.counts) + ")");
});
