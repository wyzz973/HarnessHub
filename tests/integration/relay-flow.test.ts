import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import { BLIND, Fakes, LIVE, declared, decisionOf, eventOf, events, fromAlpha, relayOf, turn, to, world } from "../fixtures/relay-fakes.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// The relay through the formal Runtime and a real SqliteSessionStore (slim.md): what a Turn sends, what the binding records, and
// what a restart leaves. The Harnesses are in-process fakes that keep a native history; nothing here runs a Harness.

const kinds = (state: SessionSnapshot) => state.runs.map(run => run.relay?.kind ?? null);

test("a conversation on one Harness is never injected: every input, the first one too, reaches it exactly as typed", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  for (const [index, text] of ["one", "/compact", "two", "/undo", "three"].entries()) await turn(app, id, text, "k" + index);
  assert.deepEqual(fakes.to("alpha").map(row => row.text), ["one", "/compact", "two", "/undo", "three"]);
  assert.equal(fakes.carried("alpha"), 0);
  assert.equal(events(w.store, id).filter(row => row.type === "run.context_prepared" && row.data.relay !== undefined).length, 0, "no relay record at all");
  // A rewind with nothing foreign to send is no reason to send anything.
  assert.deepEqual(app.read(id).nativeBindings!.map(row => row.relay!.resendAll), [true]);
});

test("A → B → A: bravo gets a packet of alpha's Turns, back on alpha only bravo's Turns go as an update, and staying put injects nothing", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  const b1 = await turn(app, id, "b1 a question for bravo", "b1");
  assert.equal(b1.status, "completed"); assert.equal(fakes.carried("bravo"), 1);
  const first = readRelayPrompt(fakes.to("bravo")[0]!.text);
  assert.equal(first.packet, true); assert.equal(first.kind, "packet"); assert.equal(first.currentInput.text, "b1 a question for bravo");
  assert.deepEqual(first.history.map(row => row.user.text), ["a1 a fact on alpha"]);
  // The completed Turn proves the packet recorded (E3): the binding holds alpha's Turn and nothing waits.
  const delivery = w.store.relayDeliveries(id).find(row => row.runId === b1.id)!;
  assert.deepEqual([delivery.outcome.kind, delivery.outcome.kind === "recorded" ? delivery.outcome.evidence : null, delivery.autoResend], ["recorded", "E3", false]);
  const bravo = relayOf(app.read(id), "bravo");
  assert.equal(bravo.pending, null); assert.ok(bravo.mark >= 1, "the mark moved up to the packet's end: " + bravo.mark); assert.equal(bravo.epoch, 1);
  // Staying on bravo: nothing is owed, nothing is injected.
  await turn(app, id, "b2 again", "b2");
  assert.equal(fakes.carried("bravo"), 1); assert.equal(fakes.to("bravo")[1]!.text, "b2 again");
  // Back on alpha: its native session holds a1; it is owed bravo's two Turns, as an update.
  await to(app, id, "alpha", "to-alpha");
  const a2 = await turn(app, id, "a2 back on alpha", "a2");
  const back = readRelayPrompt(fakes.to("alpha").at(-1)!.text);
  assert.equal(back.packet, true); assert.equal(back.kind, "delta"); assert.equal(back.currentInput.text, "a2 back on alpha");
  assert.deepEqual(back.history.map(row => row.user.text), ["b1 a question for bravo", "b2 again"]);
  assert.deepEqual(fakes.to("alpha")[0]!.text, "a1 a fact on alpha", "alpha's first input went as typed");
  assert.deepEqual(kinds(app.read(id)), [null, "packet", null, "delta"]);
  assert.equal(a2.relay?.continuity.kind, "native_resume_delta");
  assert.equal(relayOf(app.read(id), "alpha").pending, null);
});

test("a packet that nothing confirms is sent again once, then the Turns go alone, until there is a new fact: the new packet carries everything owed", async t => {
  // A Driver that can show a delivery (it reports the entry as an event) and does not here: a send stays unknown.
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(LIVE) }, "bravo");
  fakes.script = (harnessId, input) => harnessId === "bravo" ? { result: "unrecorded" } : {};
  const runs = [];
  for (const [index, text] of ["b1", "b2", "b3", "b4"].entries()) runs.push(await turn(app, id, text, "k" + index));
  assert.deepEqual(runs.map(run => decisionOf(w.store, id, run.id)), [{ kind: "carry", by: "need" }, { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" },
    { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }]);
  assert.equal(fakes.carried("bravo"), 2, "the packet went twice and no more");
  const pending = relayOf(app.read(id), "bravo").pending!;
  assert.equal(pending.autoResends, 1);
  assert.deepEqual(w.store.relayDeliveries(id).map(row => [row.autoResend, row.outcome.kind]), [[false, "unknown"], [true, "unknown"]]);
  // A new fact for bravo: alpha says something; back on bravo one packet carries a1 (never confirmed) and the new fact, counted from 0 again.
  await to(app, id, "alpha", "back-to-alpha"); await turn(app, id, "a2 a new fact", "a2"); await to(app, id, "bravo", "back-to-bravo");
  const b5 = await turn(app, id, "b5", "k5");
  assert.deepEqual(decisionOf(w.store, id, b5.id), { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "grown" });
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a1 a fact on alpha", "a2 a new fact"]);
  assert.equal(relayOf(app.read(id), "bravo").pending!.autoResends, 0);
});

test("a Driver that can never show a delivery sends a packet once: nothing it does confirms an input, so the next Turns go alone", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(BLIND) }, "bravo");
  fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
  const runs = [await turn(app, id, "b1", "k1"), await turn(app, id, "b2", "k2"), await turn(app, id, "b3", "k3")];
  assert.deepEqual(runs.map(run => decisionOf(w.store, id, run.id)), [{ kind: "carry", by: "need" }, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }]);
  assert.equal(fakes.carried("bravo"), 1);
  assert.deepEqual(fakes.to("bravo").slice(1).map(row => row.text), ["b2", "b3"], "the words as typed");
  assert.equal(relayOf(app.read(id), "bravo").pending?.autoResends, 0, "never sent again by itself");
});

test("a Turn stopped right after its packet went: recorded when the Driver reported the entry, sent again once when nothing did", async t => {
  for (const reported of [true, false]) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(LIVE) }, "bravo");
    fakes.script = harnessId => harnessId === "bravo" ? { result: "hold", live: reported } : {};
    const receipt = app.send(id, "b1 stopped soon", "k1");
    await fakes.reached("bravo", 1);
    app.cancel(id, "stop"); await app.wait(id);
    const stopped = app.read(id).runs.find(run => run.id === receipt.runId)!;
    assert.equal(stopped.status, "cancelled");
    const delivery = w.store.relayDeliveries(id).find(row => row.runId === stopped.id)!, bravo = relayOf(app.read(id), "bravo");
    fakes.script = () => ({});
    const next = await turn(app, id, "b2", "k2");
    if (reported) {
      assert.deepEqual([delivery.outcome.kind, delivery.outcome.kind === "recorded" ? delivery.outcome.evidence : null], ["recorded", "E1"], "reported before the stop");
      assert.equal(bravo.pending, null); assert.equal(decisionOf(w.store, id, next.id), undefined); assert.equal(fakes.carried("bravo"), 1, "nothing to send again");
      assert.equal(eventOf(w.store, id, "relay.input_recorded", stopped.id)?.data.live, "recorded_event");
    } else {
      assert.equal(delivery.outcome.kind, "unknown"); assert.equal(bravo.pending?.autoResends, 0);
      assert.deepEqual(decisionOf(w.store, id, next.id), { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" }); assert.equal(fakes.carried("bravo"), 2);
      assert.equal(relayOf(app.read(id), "bravo").pending, null, "and this time it ended normally: recorded");
    }
  }
});

test("a clear opens a new native session and leaves the earlier part behind; the next message carries none of it, and the user may attach it once", async t => {
  for (const style of ["in place", "replaced"] as const) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
    await turn(app, id, "b1 before the clear", "k1");
    const before = relayOf(app.read(id), "bravo");
    fakes.script = (_harnessId, input) => input === "/clear" ? { cleared: style === "in place" ? true : { replaced: { checkpoint: null } } } : {};
    const cleared = await turn(app, id, "/clear", "clear");
    assert.equal(cleared.status, "completed"); assert.equal(fakes.to("bravo").at(-1)!.text, "/clear", "a command carries nothing");
    const state = app.read(id), bravo = relayOf(state, "bravo");
    assert.deepEqual([bravo.epoch, bravo.mark, bravo.pending, bravo.resendAll], [before.epoch + 1, -1, null, false], style);
    assert.equal(bravo.floor, events(w.store, id).find(row => row.type === "run.ended" && row.data.runId === cleared.id)!.seq, "the clear is the floor");
    if (style === "replaced") assert.deepEqual(state.nativeBindings!.filter(row => row.harnessId === "bravo").map(row => row.status), ["archived", "ready"]);
    // The cleared conversation offers the earlier part once, and sends none of it by itself.
    const offered = app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention;
    assert.deepEqual([offered?.cause, offered?.options, offered?.counts.runs], ["attach_available", ["attach_full"], 2]);
    fakes.script = () => ({});
    const attached = await turn(app, id, "b2 with the earlier part", "k2", { attach: "full" });
    const packet = readRelayPrompt(fakes.to("bravo").at(-1)!.text);
    assert.deepEqual(packet.history.map(row => row.user.text), ["a1 a fact on alpha", "b1 before the clear"], style);
    assert.deepEqual(decisionOf(w.store, id, attached.id), { kind: "carry", by: "user" });
    assert.equal(app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention, null, "once: the Turn that ran after the clear ends the offer");
    // Without the user's attach nothing before the clear goes (the second Session of the pair is the control).
  }
  const { fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  await turn(app, id, "b1 before the clear", "k1");
  fakes.script = (_harnessId, input) => input === "/clear" ? { cleared: true } : {};
  await turn(app, id, "/clear", "clear");
  await turn(app, id, "b2 after the clear", "k2");
  assert.equal(fakes.carried("bravo"), 1, "no packet after the clear: the first one is all there is");
  await to(app, id, "alpha", "back-to-alpha"); await turn(app, id, "a2 a new fact", "a2"); await to(app, id, "bravo", "back-to-bravo"); await turn(app, id, "b3", "k3");
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a2 a new fact"], "only what came after the clear is owed");
});

test("a rewind makes the next packet carry everything again, once", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  await turn(app, id, "b1", "k1");
  await to(app, id, "alpha", "to-alpha-2"); await turn(app, id, "a2 second fact on alpha", "a2"); await to(app, id, "bravo", "to-bravo-2");
  const b2 = await turn(app, id, "b2", "k2");
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a2 second fact on alpha"], "an update: bravo held a1");
  assert.equal(b2.relay?.kind, "delta");
  // A command that took Turns out of bravo's native history: it may hold less than the relay recorded.
  const undone = await turn(app, id, "/undo", "undo");
  assert.equal(undone.status, "completed"); assert.equal(relayOf(app.read(id), "bravo").resendAll, true);
  assert.equal(fakes.to("bravo").at(-1)!.text, "/undo", "the command goes as typed");
  const b3 = await turn(app, id, "b3", "k3");
  assert.deepEqual(decisionOf(w.store, id, b3.id), { kind: "carry", by: "policy", cause: "history_changed", resend: "all" });
  assert.equal(b3.relay?.kind, "packet", "a complete packet, not an update");
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a1 a fact on alpha", "a2 second fact on alpha"]);
  const bravo = relayOf(app.read(id), "bravo");
  assert.deepEqual([bravo.resendAll, bravo.pending], [false, null], "sent once, and recorded");
  const b4 = await turn(app, id, "b4", "k4");
  assert.equal(decisionOf(w.store, id, b4.id), undefined, "nothing more to send");
  // A compaction changes nothing.
  const before = relayOf(app.read(id), "bravo");
  await turn(app, id, "/compact", "compact"); assert.deepEqual(relayOf(app.read(id), "bravo"), before);
});

test("\"only this message\" sends the words as typed and leaves what is owed owed; the next message carries it", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  const alone = await turn(app, id, "b1 alone", "k1", { attach: "none" });
  assert.equal(fakes.to("bravo")[0]!.text, "b1 alone"); assert.deepEqual(decisionOf(w.store, id, alone.id), { kind: "alone", by: "user" });
  assert.deepEqual([relayOf(app.read(id), "bravo").mark, relayOf(app.read(id), "bravo").pending], [-1, null]);
  const b2 = await turn(app, id, "b2", "k2");
  assert.equal(readRelayPrompt(fakes.to("bravo")[1]!.text).packet, true); assert.equal(b2.relay?.kind, "packet");
  assert.deepEqual(readRelayPrompt(fakes.to("bravo")[1]!.text).history.map(row => row.user.text), ["a1 a fact on alpha"]);
  // Asking for the history when there is none to attach goes as typed and says so.
  const none = await turn(app, id, "b3", "k3", { attach: "full" });
  assert.deepEqual(decisionOf(w.store, id, none.id), { kind: "carry", by: "user" }, "the whole history again, the user's choice");
  const fresh = world(t), solo = new Fakes({ alpha: declared() }), one = fresh.runtime(solo), sid = (await one.create(fresh.configuration, { harnessId: "alpha" }, "create")).id;
  const nothing = await turn(one, sid, "a1", "k1", { attach: "full" });
  assert.deepEqual(decisionOf(fresh.store, sid, nothing.id), { kind: "plain", by: "user" }); assert.equal(solo.to("alpha")[0]!.text, "a1");
});

test("a Turn whose end is unknown, continued on the original session, sends everything again at the next one", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.script = harnessId => harnessId === "bravo" ? { result: "lost" } : {};
  const lost = await turn(app, id, "b1 lost", "k1");
  assert.equal(lost.status, "unknown"); assert.equal(app.read(id).status, "blocked");
  const bravo = relayOf(app.read(id), "bravo");
  assert.deepEqual([bravo.pending?.autoResends, bravo.resendAll], [0, true], "the packet may have arrived, and the native session may hold more or less: both are said");
  fakes.script = () => ({});
  app.resume(id, { harnessId: "bravo" }, "resume", true); await app.wait(id);
  const next = await turn(app, id, "b2", "k2");
  assert.deepEqual(decisionOf(w.store, id, next.id), { kind: "carry", by: "policy", cause: "history_changed", resend: "all" });
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a1 a fact on alpha"]);
  assert.equal(fakes.to("bravo").at(-1)!.session, fakes.to("bravo")[0]!.session, "the original native session");
});

test("a packet that cannot be prepared goes as the words alone and says why; when the user asked for it the Turn fails and nothing is lost", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.secretsFail = true;
  const b1 = await turn(app, id, "b1", "k1");
  assert.equal(b1.status, "completed"); assert.equal(fakes.to("bravo")[0]!.text, "b1");
  assert.deepEqual(decisionOf(w.store, id, b1.id), { kind: "alone", by: "policy", cause: "prepare_failed", reason: "redaction_failed" });
  // The user asked for it: the Turn fails before dispatch with the relay's code.
  const asked = await turn(app, id, "b2", "k2", { attach: "full" });
  assert.equal(asked.status, "failed"); assert.equal(asked.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(fakes.to("bravo").length, 1, "nothing was dispatched");
  fakes.secretsFail = false;
  const b3 = await turn(app, id, "b3", "k3");
  assert.equal(readRelayPrompt(fakes.to("bravo")[1]!.text).packet, true, "what was owed is carried once it can be");
  assert.equal(b3.status, "completed"); assert.equal(relayOf(app.read(id), "bravo").pending, null);
});

test("the installation's setting \"off\" hands nothing over by itself; the user's attach still does", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  w.store.setPref("relay.attach", "off");
  const b1 = await turn(app, id, "b1", "k1");
  assert.equal(fakes.to("bravo")[0]!.text, "b1"); assert.deepEqual(decisionOf(w.store, id, b1.id), { kind: "alone", by: "user" });
  const b2 = await turn(app, id, "b2", "k2", { attach: "full" });
  assert.equal(readRelayPrompt(fakes.to("bravo")[1]!.text).packet, true); assert.deepEqual(decisionOf(w.store, id, b2.id), { kind: "carry", by: "user" });
  w.store.setPref("relay.attach", "auto");
});

test("the first handoff to a Harness is logged once, and its delivery names the row", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  assert.deepEqual(w.store.handoffs(), []);
  const b1 = await turn(app, id, "b1", "k1");
  const [row] = w.store.handoffs(); assert.equal(row?.harnessId, "bravo");
  assert.equal(w.store.relayDeliveries(id).find(delivery => delivery.runId === b1.id)?.handoffLogSeq, row!.logSeq);
  assert.deepEqual((eventOf(w.store, id, "run.context_prepared", b1.id)?.data.relay as Record<string, unknown>).handoff, { logSeq: row!.logSeq, first: true });
  await to(app, id, "alpha", "to-alpha-2"); await turn(app, id, "a2", "a2"); await to(app, id, "bravo", "to-bravo-2");
  const b2 = await turn(app, id, "b2", "k2");
  assert.deepEqual(w.store.handoffs().map(row => row.harnessId), ["bravo", "alpha"], "alpha was handed history too; bravo has no second row");
  assert.deepEqual((eventOf(w.store, id, "run.context_prepared", b2.id)?.data.relay as Record<string, unknown>).handoff, { logSeq: row!.logSeq }, "and not the first any more");
  assert.equal(fakes.carried("bravo"), 2);
});

test("a window that cannot hold even the smallest packet sends the words alone, and says so", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared(), bravo: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "bravo" }, "create")).id;
  fakes.usage.bravo = { context: { used: 100, size: 3000 } };
  await turn(app, id, "b1 on a small window", "b1");
  await to(app, id, "alpha", "to-alpha"); await turn(app, id, "a1", "a1"); await to(app, id, "bravo", "back-to-bravo");
  const b2 = await turn(app, id, "b2", "b2");
  assert.deepEqual(decisionOf(w.store, id, b2.id), { kind: "alone", by: "policy", cause: "input_limit", reason: "input_limit" });
  assert.equal(fakes.to("bravo").at(-1)!.text, "b2");
});

test("a native session a handoff opened is named before its first prompt, by the Driver's declaration", async t => {
  const { fakes, app, id } = await fromAlpha(t, { bravo: declared({ title: "set" }) }, "bravo");
  await turn(app, id, "b1", "k1");
  assert.deepEqual(fakes.titles.map(row => row.harnessId), ["bravo"]); assert.match(fakes.titles[0]!.title, /a1 a fact on alpha/u);
  await turn(app, id, "b2", "k2");
  assert.equal(fakes.titles.length, 1, "named once: the second Turn opens no native session");
});

/** A new owner on the same data: a new Store (which recovers what the old one left), a new Runtime and new Harnesses. */
function restarted(t: import("node:test").TestContext, data: string, declarations: ConstructorParameters<typeof Fakes>[0]) {
  const store = new SqliteSessionStore(data, { recoverRelay }), fakes = new Fakes(declarations), counter = { value: 0 };
  const app = new SessionRuntime(store, fakes, { id: () => "restart-" + ++counter.value, now: () => new Date(Date.UTC(2026, 10, 11, 13)), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  t.after(async () => { try { await app.close(); } catch { /* closed */ } try { store.close(); } catch { /* closed */ } });
  return { store, fakes, app };
}

test("after a restart a packet nothing confirmed is still waited for: the next Turn sends it again once", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(LIVE) }, "bravo");
  fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
  await turn(app, id, "b1", "k1");
  assert.equal(relayOf(app.read(id), "bravo").pending?.autoResends, 0);
  await app.close(); w.store.close();
  const next = restarted(t, w.data, { alpha: declared(), bravo: declared(LIVE) });
  assert.equal(relayOf(next.app.read(id), "bravo").pending?.autoResends, 0, "kept across the restart");
  const b2 = await turn(next.app, id, "b2 after the restart", "k2");
  assert.deepEqual(decisionOf(next.store, id, b2.id), { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" });
  assert.deepEqual(readRelayPrompt(next.fakes.to("bravo")[0]!.text).history.map(row => row.user.text), ["a1 a fact on alpha"]);
  assert.equal(relayOf(next.app.read(id), "bravo").pending, null, "this time it ended normally");
});

test("a packet that was on its way when the Hub went away is waited for by the next owner (it may have arrived, and nothing says so)", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(LIVE) }, "bravo");
  fakes.script = harnessId => harnessId === "bravo" ? { result: "hold" } : {};
  const sent = app.send(id, "b1 in flight", "k1");
  await fakes.reached("bravo", 1);
  w.store.close();
  const next = restarted(t, w.data, { alpha: declared(), bravo: declared(LIVE) }), recovered = next.store.get(id);
  assert.equal(recovered.runs.find(run => run.id === sent.runId)?.status, "unknown");
  assert.equal(next.store.relayDeliveries(id).find(row => row.runId === sent.runId)?.outcome.kind, "unknown");
  assert.deepEqual([relayOf(recovered, "bravo").pending?.autoResends, relayOf(recovered, "bravo").resendAll], [0, false], "the packet may have arrived, and nothing says so");
  // A packet that never left is no packet: a Run recovered before it was dispatched changes nothing.
  fakes.release();
});
