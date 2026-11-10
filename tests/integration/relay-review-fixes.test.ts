import assert from "node:assert/strict";
import { test } from "node:test";
import { consentSourceOf, relayDecisionOf, type RelayDecision, type VendorKey } from "../../src/contracts/relay.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import type { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import type { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { CHECKING, declared, eventOf, events, fromAlpha, refusedAt, relayOf, seen, to, turn } from "../fixtures/relay-fakes.js";

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
