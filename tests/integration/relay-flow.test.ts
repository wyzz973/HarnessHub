import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import { conversationLabel } from "../../src/contexts/session/domain/board-words.js";
import { ContextFiles } from "../../src/web/context-files.js";
import { BLIND, Fakes, LIVE, declared, decisionOf, eventOf, events, fromAlpha, relayOf, turn, to, world, type Script } from "../fixtures/relay-fakes.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { appStore } from "../fixtures/runtime-store.js";
import type { FileConversationStore } from "../../src/infrastructure/session/file-store.js";
import { oldShape } from "../fixtures/old-shape.js";

// The relay through the formal Runtime and a real FileConversationStore (slim.md): what a Turn sends, what the binding records, and
// what a restart leaves. The Harnesses are in-process fakes that keep a native history; nothing here runs a Harness.

const kinds = (state: SessionSnapshot) => state.runs.map(run => run.relay?.kind ?? null);

test("a conversation on one Harness is never injected: every input, the first one too, reaches it exactly as typed", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  for (const [index, text] of ["one", "/compact", "two", "/undo", "three"].entries()) await turn(app, id, text, "k" + index);
  assert.deepEqual(fakes.to("alpha").map(row => row.text), ["one", "/compact", "two", "/undo", "three"]);
  assert.equal(fakes.carried("alpha"), 0);
  assert.equal(events(w.store, id).filter(row => row.type === "run.context_prepared" && row.data.relay !== undefined).length, 0, "no relay record at all");
  // A rewind with nothing foreign to send is no reason to send anything.
  assert.deepEqual(oldShape(app, id).nativeBindings!.map(row => row.relay!.resendAll), [true]);
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
  const bravo = relayOf(oldShape(app, id), "bravo");
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
  assert.deepEqual(kinds(oldShape(app, id)), [null, "packet", null, "delta"]);
  assert.equal(a2.relay?.continuity.kind, "native_resume_delta");
  assert.equal(relayOf(oldShape(app, id), "alpha").pending, null);
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
  const pending = relayOf(oldShape(app, id), "bravo").pending!;
  assert.equal(pending.autoResends, 1);
  assert.deepEqual(w.store.relayDeliveries(id).map(row => [row.autoResend, row.outcome.kind]), [[false, "unknown"], [true, "unknown"]]);
  // A new fact for bravo: alpha says something; back on bravo one packet carries a1 (never confirmed) and the new fact, counted from 0 again.
  await to(app, id, "alpha", "back-to-alpha"); await turn(app, id, "a2 a new fact", "a2"); await to(app, id, "bravo", "back-to-bravo");
  const b5 = await turn(app, id, "b5", "k5");
  assert.deepEqual(decisionOf(w.store, id, b5.id), { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "grown" });
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a1 a fact on alpha", "a2 a new fact"]);
  assert.equal(relayOf(oldShape(app, id), "bravo").pending!.autoResends, 0);
});

test("a Driver that can never show a delivery sends a packet once: nothing it does confirms an input, so the next Turns go alone", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(BLIND) }, "bravo");
  fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
  const runs = [await turn(app, id, "b1", "k1"), await turn(app, id, "b2", "k2"), await turn(app, id, "b3", "k3")];
  assert.deepEqual(runs.map(run => decisionOf(w.store, id, run.id)), [{ kind: "carry", by: "need" }, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }]);
  assert.equal(fakes.carried("bravo"), 1);
  assert.deepEqual(fakes.to("bravo").slice(1).map(row => row.text), ["b2", "b3"], "the words as typed");
  assert.equal(relayOf(oldShape(app, id), "bravo").pending?.autoResends, 0, "never sent again by itself");
});

test("a Turn stopped right after its packet went: recorded when the Driver reported the entry, sent again once when nothing did", async t => {
  for (const reported of [true, false]) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(LIVE) }, "bravo");
    fakes.script = harnessId => harnessId === "bravo" ? { result: "hold", live: reported } : {};
    const receipt = app.send(id, "b1 stopped soon", "k1");
    await fakes.reached("bravo", 1);
    app.cancel(id, "stop"); await app.wait(id);
    const stopped = oldShape(app, id).runs.find(run => run.id === receipt.runId)!;
    assert.equal(stopped.status, "cancelled");
    const delivery = w.store.relayDeliveries(id).find(row => row.runId === stopped.id)!, bravo = relayOf(oldShape(app, id), "bravo");
    fakes.script = () => ({});
    const next = await turn(app, id, "b2", "k2");
    if (reported) {
      assert.deepEqual([delivery.outcome.kind, delivery.outcome.kind === "recorded" ? delivery.outcome.evidence : null], ["recorded", "E1"], "reported before the stop");
      assert.equal(bravo.pending, null); assert.equal(decisionOf(w.store, id, next.id), undefined); assert.equal(fakes.carried("bravo"), 1, "nothing to send again");
      assert.equal(eventOf(w.store, id, "relay.input_recorded", stopped.id)?.data.live, "recorded_event");
    } else {
      assert.equal(delivery.outcome.kind, "unknown"); assert.equal(bravo.pending?.autoResends, 0);
      assert.deepEqual(decisionOf(w.store, id, next.id), { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" }); assert.equal(fakes.carried("bravo"), 2);
      assert.equal(relayOf(oldShape(app, id), "bravo").pending, null, "and this time it ended normally: recorded");
    }
  }
});

test("a clear opens a new native session and leaves the earlier part behind; the next message carries none of it, and the user may attach it once", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  await turn(app, id, "b1 before the clear", "k1");
  const before = relayOf(oldShape(app, id), "bravo");
  fakes.script = (_harnessId, input) => input === "/clear" ? { cleared: true } : {};
  const cleared = await turn(app, id, "/clear", "clear");
  assert.equal(cleared.status, "completed"); assert.equal(fakes.to("bravo").at(-1)!.text, "/clear", "a command carries nothing");
  const state = oldShape(app, id), bravo = relayOf(state, "bravo");
  assert.deepEqual([bravo.epoch, bravo.mark, bravo.pending, bravo.resendAll], [before.epoch + 1, -1, null, false]);
  assert.equal(bravo.floor, events(w.store, id).find(row => row.type === "run.ended" && row.data.runId === cleared.id)!.seq, "the clear is the floor");
  assert.deepEqual(state.nativeBindings!.filter(row => row.harnessId === "bravo").map(row => row.status), ["archived", "ready"], "the native session was given up for a new one");
  // The cleared conversation offers the earlier part once, and sends none of it by itself.
  const offered = app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention;
  assert.deepEqual([offered?.cause, offered?.options, offered?.counts.runs], ["attach_available", ["attach_full"], 2]);
  fakes.script = () => ({});
  const attached = await turn(app, id, "b2 with the earlier part", "k2", { attach: "full" });
  const packet = readRelayPrompt(fakes.to("bravo").at(-1)!.text);
  assert.deepEqual(packet.history.map(row => row.user.text), ["a1 a fact on alpha", "b1 before the clear"]);
  assert.deepEqual(decisionOf(w.store, id, attached.id), { kind: "carry", by: "user" });
  assert.equal(app.relayAttention(id).find(row => row.harnessId === "bravo")!.attention, null, "once: the Turn that ran after the clear ends the offer");
});

test("without the user's attach nothing before a clear goes, and only what comes after it is owed", async t => {
  const { fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  await turn(app, id, "b1 before the clear", "k1");
  fakes.script = (_harnessId, input) => input === "/clear" ? { cleared: true } : {};
  await turn(app, id, "/clear", "clear");
  await turn(app, id, "b2 after the clear", "k2");
  assert.equal(fakes.carried("bravo"), 1, "no packet after the clear: the first one is all there is");
  await to(app, id, "alpha", "back-to-alpha"); await turn(app, id, "a2 a new fact", "a2"); await to(app, id, "bravo", "back-to-bravo"); await turn(app, id, "b3", "k3");
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a2 a new fact"], "only what came after the clear is owed");
});

// The independent review of 2026-11-11 (persistent format): the clear boundary was written only when the program's close was clean. One that
// ended with a protocol failure left the binding unconfirmed although the Driver had let the native session go, and the native session the
// user then started inherited the old floor: everything before the clear was handed over again.
test("a clear the Driver reported is the clear boundary whether or not the program's close was clean: nothing before it is handed over again, with or without a native session of the user's own", async t => {
  const failure = { code: "INVALID_PROTOCOL", message: "the program broke the protocol while it closed" };
  const variants = [{ label: "a protocol failure at the close, straight on", reset: false, close: { closed: true, exitCode: 0, signal: null, protocolFailure: failure } as const },
    { label: "a protocol failure at the close, after a native reset", reset: true, close: { closed: true, exitCode: 0, signal: null, protocolFailure: failure } as const },
    // A close that threw leaves the Turn unknown and the conversation blocked until the program is confirmed gone; the clear the Driver reported stands.
    { label: "a close that threw", reset: false, close: new SessionError("CLEANUP_FAILED", "the program could not be ended") }];
  for (const { label, reset, close } of variants) {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
    await turn(app, id, "b1 before the clear", "k1");
    const before = relayOf(oldShape(app, id), "bravo");
    fakes.script = (_harnessId, input) => input === "/clear" ? { cleared: true } : {};
    fakes.closing.bravo = close;
    const cleared = await turn(app, id, "/clear", "clear");
    assert.deepEqual([cleared.status, cleared.error?.code], close instanceof Error ? ["unknown", "CLEANUP_FAILED"] : ["failed", failure.code], label + ": the Turn reports what the close found");
    const ended = events(w.store, id).find(row => row.type === "run.ended" && row.data.runId === cleared.id)!;
    assert.equal(ended.data.contextEffect, "clear", label + ": and a clear the Driver reported is a clear all the same");
    const state = oldShape(app, id), bravo = relayOf(state, "bravo");
    assert.deepEqual([bravo.epoch, bravo.mark, bravo.pending, bravo.resendAll, bravo.floor], [before.epoch + 1, -1, null, false, ended.seq], label + ": the clear is the boundary, as when the close is clean");
    assert.deepEqual(state.nativeBindings!.filter(row => row.harnessId === "bravo").map(row => row.status), ["archived", "ready"], label + ": the Driver gave the native session up: no binding waits for a confirmation of it");
    if (close instanceof Error) { assert.equal(state.status, "blocked", label + ": the conversation waits for the program to be confirmed gone"); continue; }
    fakes.closing = {}; fakes.script = () => ({});
    if (reset) assert.equal(app.resetNative(id, "reset", oldShape(app, id).epoch).status, "open");
    const b2 = await turn(app, id, "b2 after the clear", "k2");
    assert.equal(b2.status, "completed", label + ": " + JSON.stringify(b2.error));
    assert.equal(fakes.to("bravo").at(-1)!.text, "b2 after the clear", label + ": as typed, nothing of the earlier part");
    assert.equal(fakes.carried("bravo"), 1, label + ": the first packet is all there ever was"); assert.equal(decisionOf(w.store, id, b2.id), undefined);
    assert.equal(relayOf(oldShape(app, id), "bravo").floor, ended.seq, label + ": and the boundary stays");
  }
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
  assert.equal(undone.status, "completed"); assert.equal(relayOf(oldShape(app, id), "bravo").resendAll, true);
  assert.equal(fakes.to("bravo").at(-1)!.text, "/undo", "the command goes as typed");
  const b3 = await turn(app, id, "b3", "k3");
  assert.deepEqual(decisionOf(w.store, id, b3.id), { kind: "carry", by: "policy", cause: "history_changed", resend: "all" });
  assert.equal(b3.relay?.kind, "packet", "a complete packet, not an update");
  assert.deepEqual(readRelayPrompt(fakes.to("bravo").at(-1)!.text).history.map(row => row.user.text), ["a1 a fact on alpha", "a2 second fact on alpha"]);
  const bravo = relayOf(oldShape(app, id), "bravo");
  assert.deepEqual([bravo.resendAll, bravo.pending], [false, null], "sent once, and recorded");
  const b4 = await turn(app, id, "b4", "k4");
  assert.equal(decisionOf(w.store, id, b4.id), undefined, "nothing more to send");
  // A compaction changes nothing.
  const before = relayOf(oldShape(app, id), "bravo");
  await turn(app, id, "/compact", "compact"); assert.deepEqual(relayOf(oldShape(app, id), "bravo"), before);
});

// The independent review of 2026-11-11 (persistent format and lost content): a command read as a command that enters the context like a
// message (a skill, a custom command: the effect keep) was left out of every packet and the mark went past it, so the next Harness never
// heard of that Turn.
test("a command that enters the context like a message (effect keep) is a fact of the conversation: the Harness switched to is given its Turn; no other kind of command is one", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared(), bravo: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  await turn(app, id, "a1 a fact on alpha", "a1");
  const skill = await turn(app, id, "/skill:review 请修复 X", "skill");
  assert.equal(skill.status, "completed"); assert.equal(fakes.to("alpha").at(-1)!.text, "/skill:review 请修复 X", "a command goes as typed and carries nothing");
  // A command that leaves the history alone, compacts it, rewinds it, clears it (nobody confirmed) or has an unknown effect puts nothing into
  // the conversation, and neither does a keep command that was refused before it ran.
  for (const [index, words] of ["/status", "/compact", "/mystery", "/undo", "/clear"].entries()) assert.equal((await turn(app, id, words, "other" + index)).status, "completed", words);
  fakes.script = (_harnessId, input) => input === "/skill:review refused" ? { result: "not_recorded" } : {};
  assert.equal((await turn(app, id, "/skill:review refused", "refused")).status, "failed");
  fakes.script = () => ({});
  await to(app, id, "bravo", "to-bravo");
  const b1 = await turn(app, id, "b1 the first message on bravo", "b1");
  assert.equal(b1.status, "completed");
  const first = readRelayPrompt(fakes.to("bravo")[0]!.text);
  assert.equal(first.packet, true);
  assert.deepEqual(first.history.map(row => row.user.text), ["a1 a fact on alpha", "/skill:review 请修复 X"], "alpha's Turn and its skill, in order, and nothing else");
  // The packet's end is the skill's: the mark covers it, and nothing more is owed.
  const skillEnded = events(w.store, id).find(row => row.type === "run.ended" && row.data.runId === skill.id)!.seq, bravo = relayOf(oldShape(app, id), "bravo");
  assert.deepEqual([bravo.mark, bravo.pending], [skillEnded, null]);
  await turn(app, id, "b2", "b2"); assert.equal(fakes.carried("bravo"), 1, "nothing is owed any more");
});

test("a command that enters the context carries no packet itself, whatever its Harness is owed; its Turn is owed to the others, and is not owed back to the Harness that ran it", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  const skill = await turn(app, id, "/skill:review 请修复 X", "skill");
  assert.equal(skill.status, "completed"); assert.equal(fakes.to("bravo")[0]!.text, "/skill:review 请修复 X", "as typed: bravo is owed a1, and the command carries nothing");
  assert.equal(fakes.carried("bravo"), 0); assert.equal(decisionOf(w.store, id, skill.id), undefined);
  assert.equal(relayOf(oldShape(app, id), "bravo").mark, -1, "the command settled nothing owed");
  // The next message carries what bravo is owed: a1 only — its own skill Turn is not foreign to it.
  await turn(app, id, "b1", "b1");
  assert.deepEqual(readRelayPrompt(fakes.to("bravo")[1]!.text).history.map(row => row.user.text), ["a1 a fact on alpha"]);
  // Back on alpha, which is owed bravo's two Turns, the skill one included.
  await to(app, id, "alpha", "to-alpha");
  await turn(app, id, "a2", "a2");
  assert.deepEqual(readRelayPrompt(fakes.to("alpha").at(-1)!.text).history.map(row => row.user.text), ["/skill:review 请修复 X", "b1"]);
});

test("\"only this message\" sends the words as typed and leaves what is owed owed; the next message carries it", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  const alone = await turn(app, id, "b1 alone", "k1", { attach: "none" });
  assert.equal(fakes.to("bravo")[0]!.text, "b1 alone"); assert.deepEqual(decisionOf(w.store, id, alone.id), { kind: "alone", by: "user" });
  assert.deepEqual([relayOf(oldShape(app, id), "bravo").mark, relayOf(oldShape(app, id), "bravo").pending], [-1, null]);
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
  assert.equal(lost.status, "unknown"); assert.equal(oldShape(app, id).status, "blocked");
  const bravo = relayOf(oldShape(app, id), "bravo");
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
  assert.equal(b3.status, "completed"); assert.equal(relayOf(oldShape(app, id), "bravo").pending, null);
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
  const store = appStore(data), fakes = new Fakes(declarations), counter = { value: 0 };
  const app = new SessionRuntime(store, fakes, { id: () => "restart-" + ++counter.value, now: () => new Date(Date.UTC(2026, 10, 11, 13)), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  t.after(async () => { try { await app.close(); } catch { /* closed */ } try { store.close(); } catch { /* closed */ } });
  return { store, fakes, app };
}

test("after a restart a packet nothing confirmed is still waited for: the next Turn sends it again once", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(LIVE) }, "bravo");
  fakes.script = harnessId => harnessId === "bravo" ? { result: "unrecorded" } : {};
  await turn(app, id, "b1", "k1");
  assert.equal(relayOf(oldShape(app, id), "bravo").pending?.autoResends, 0);
  await app.close(); w.store.close();
  const next = restarted(t, w.data, { alpha: declared(), bravo: declared(LIVE) });
  assert.equal(relayOf(oldShape(next.app, id), "bravo").pending?.autoResends, 0, "kept across the restart");
  const b2 = await turn(next.app, id, "b2 after the restart", "k2");
  assert.deepEqual(decisionOf(next.store, id, b2.id), { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" });
  assert.deepEqual(readRelayPrompt(next.fakes.to("bravo")[0]!.text).history.map(row => row.user.text), ["a1 a fact on alpha"]);
  assert.equal(relayOf(oldShape(next.app, id), "bravo").pending, null, "this time it ended normally");
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

// A new native session in the place of one that cannot go on (2026-11-13), and the state said again after a Harness compacted its own session.

test("a native session its Harness no longer has is replaced by a new one that is handed the conversation; a command to it still fails", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  await turn(app, id, "one fact", "k1");
  const lost = fakes.to("alpha")[0]!.session;
  fakes.gone.add(lost);
  // A command is meant for the session as it is: nothing takes its place for it.
  assert.equal((await turn(app, id, "/status", "k2")).status, "failed");
  const second = await turn(app, id, "two", "k3");
  assert.equal(second.status, "completed");
  const sent = fakes.to("alpha").at(-1)!, prompt = readRelayPrompt(sent.text);
  assert.notEqual(sent.session, lost);
  assert.equal(prompt.packet, true); assert.deepEqual(prompt.history.map(row => row.user.text), ["one fact"]);
  assert.match(prompt.currentInput.text, /找不回来了[\s\S]*two$/u);
  assert.equal(eventOf(w.store, id, "native.binding_reseated", second.id)?.data.reason, "lost");
  assert.deepEqual(oldShape(app, id).nativeBindings!.map(row => [row.status, row.relay!.epoch]), [["archived", 1], ["ready", 2]]);
  // The new session holds the conversation: the next Turn goes as typed.
  await turn(app, id, "three", "k4");
  assert.equal(fakes.to("alpha").at(-1)!.text, "three");
});

test("after a Turn that failed over the model's window, the next one runs in a new native session that is handed the conversation", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  await turn(app, id, "one fact", "k1");
  fakes.script = (_harnessId, input) => input === "too much" ? { result: "overflow" } : {};
  assert.equal((await turn(app, id, "too much", "k2")).status, "failed");
  const third = await turn(app, id, "go on", "k3");
  assert.equal(third.status, "completed");
  const sent = fakes.to("alpha").at(-1)!, prompt = readRelayPrompt(sent.text);
  assert.notEqual(sent.session, fakes.to("alpha")[0]!.session);
  assert.equal(prompt.packet, true); assert.deepEqual(prompt.history.map(row => row.user.text), ["one fact", "too much"]);
  assert.match(prompt.currentInput.text, /上下文满了[\s\S]*go on$/u);
  assert.equal(eventOf(w.store, id, "native.binding_reseated", third.id)?.data.reason, "overflow");
  // Nothing of it without the failure: the Turn after goes as typed, into the session the Hub opened.
  await turn(app, id, "and on", "k4");
  assert.deepEqual([fakes.to("alpha").at(-1)!.text, fakes.to("alpha").at(-1)!.session], ["and on", sent.session]);
});

test("a Harness that compacts its session in the middle of a Turn is told the state with the answer of the next Hub tool it calls, once; with no call, its next Turn says it", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() });
  const app = w.runtime(fakes, { context: { place: () => ({ dir: "/nowhere/context/c-000000", self: "c-000000" }), ensure: async () => {}, state: () => "STATE AS IT STANDS" } });
  const id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id, from = { harnessId: "alpha", controlId: "alpha-acp" };
  fakes.script = (_harnessId, input) => input === "work" ? { result: "hold", compacts: true } : input === "work again" ? { compacts: true } : {};
  app.send(id, "work", "k1"); await fakes.reached("alpha", 1);
  assert.match(app.signalsFor(id, from) ?? "", /你的上下文刚被压缩过[\s\S]*STATE AS IT STANDS/u);
  assert.equal(app.signalsFor(id, from), null, "said once in the Turn");
  fakes.release(); await app.wait(id);
  await turn(app, id, "next", "k2");
  assert.equal(fakes.to("alpha").at(-1)!.text, "next", "the Turn after does not say it a second time");
  // A Turn that compacted and called no tool of the Hub's: the state goes with the next Turn.
  await turn(app, id, "work again", "k3"); await turn(app, id, "after", "k4");
  assert.match(fakes.to("alpha").at(-1)!.text, /STATE AS IT STANDS[\s\S]*after$/u);
});

test("a session handed the conversation that overflows in its first Turn is followed by one handed less, and less again; one that went alone and overflowed is left to the user", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  const scripts = new Map<string, Script>();
  // A Turn in a session the Hub opened has the Hub's note before the user's words.
  fakes.script = (_harnessId, input) => [...scripts].find(([words]) => input === words || input.endsWith("\n" + words))?.[1] ?? {};
  const reseated = (runId: string) => eventOf(w.store, id, "native.binding_reseated", runId)?.data;
  const cap = (runId: string) => ((eventOf(w.store, id, "run.context_prepared", runId)?.data.relay as { readonly budget?: { readonly cap: number } } | undefined)?.budget?.cap);
  await turn(app, id, "one fact", "k1");
  scripts.set("too much", { result: "overflow" });
  assert.equal((await turn(app, id, "too much", "k2")).status, "failed");
  // The session that grew overflowed: the next one is handed the conversation as any handoff is. It overflows too, and says by how much.
  scripts.set("go on", { result: "overflow", context: { used: 150_000, size: 100_000 } });
  const third = await turn(app, id, "go on", "k3");
  assert.deepEqual([third.status, reseated(third.id)?.reason, reseated(third.id)?.shrink, cap(third.id)], ["failed", "overflow", 1, 64_000]);
  // It was handed the conversation and overflowed in its first Turn: the next one is handed less, by what that Turn reported (100k of 150k).
  scripts.set("still", { result: "overflow" });
  const fourth = await turn(app, id, "still", "k4");
  assert.equal(reseated(fourth.id)?.reason, "overflow"); assert.ok(Math.abs(Number(reseated(fourth.id)?.shrink) - 2 / 3) < 1e-9, String(reseated(fourth.id)?.shrink));
  assert.equal(cap(fourth.id), 33_333, "the window it reported (100k) halved, times 2/3");
  assert.notEqual(fakes.to("alpha").at(-1)!.session, fakes.to("alpha").at(-2)!.session);
  assert.equal(readRelayPrompt(fakes.to("alpha").at(-1)!.text).packet, true);
  // It reported nothing to go by: half again.
  const fifth = await turn(app, id, "and again", "k5");
  assert.equal(fifth.status, "completed"); assert.ok(Math.abs(Number(reseated(fifth.id)?.shrink) - 1 / 3) < 1e-9); assert.equal(cap(fifth.id), 16_666);
  // A session that grew overflows on a window that holds no packet: the session after it goes alone, and overflows too. Nothing could be handed less: it is left to the user.
  scripts.set("huge", { result: "overflow", context: { used: 5000, size: 3000 } });
  await turn(app, id, "huge", "k6");
  scripts.set("alone", { result: "overflow" });
  const seventh = await turn(app, id, "alone", "k7");
  assert.deepEqual([reseated(seventh.id)?.reason, reseated(seventh.id)?.shrink, decisionOf(w.store, id, seventh.id)?.kind], ["overflow", 1, "alone"]);
  const eighth = await turn(app, id, "after it", "k8");
  assert.equal(reseated(eighth.id), undefined, "no new session in its place");
  assert.deepEqual([fakes.to("alpha").at(-1)!.text, fakes.to("alpha").at(-1)!.session], ["after it", fakes.to("alpha").at(-2)!.session]);
});

test("an entry a Harness writes names the Turn it came from; a Harness that reads the record as files is told a change once it reads its STATE.md", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() }), dir = "/nowhere/context/c-000000", filed: string[] = [];
  const app: SessionRuntime = w.runtime(fakes, { context: { place: () => ({ dir, self: "c-000000" }), ensure: async () => {}, state: () => null,
    refresh: async other => { const changes = app.recordSignals(other); if (changes !== null) { filed.push(changes.text); changes.written(); } } } });
  fakes.recordFiles.add("alpha");
  const id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id, from = { harnessId: "alpha", controlId: "alpha-acp" };
  fakes.script = (_harnessId, input) => input === "work" ? { result: "hold" } : {};
  const run = app.send(id, "work", "k1").runId; await fakes.reached("alpha", 1);
  const mine = app.writeBoard(id, from, { kind: "constraint", text: "新文件以 kk_ 开头" });
  assert.deepEqual(mine.entries[0]!.from, { sessionId: id, runId: run, ordinal: 0 });
  // Written by its own Harness, it is not news to it; one the user writes is, and the conversation's STATE.md says so, each entry by who wrote it.
  assert.equal(filed.length, 0);
  app.writeBoard(id, "user", { kind: "decision", text: "用 pnpm" });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(filed.at(-1) ?? "", new RegExp("kk_ 开头（alpha 记的，依据第 1 轮用户的话：" + conversationLabel(id) + "/turns/001\\.md）[\\s\\S]*用 pnpm（用户写的）", "u"));
  // Read before it completes, nothing is told; once its read of STATE.md completes, the change is told, through the file, and not again with a tool's answer.
  fakes.emit.get("alpha")!({ type: "tool", id: "read-1", title: "Read", status: "in_progress", detail: { input: JSON.stringify({ file_path: dir + "/c-000000/STATE.md" }) } });
  assert.equal(events(w.store, id).filter(row => row.type === "run.task_board_told" && row.data.via === "file").length, 0);
  fakes.emit.get("alpha")!({ type: "tool", id: "read-1", title: "Read", status: "completed" });
  const told = events(w.store, id).filter(row => row.type === "run.task_board_told" && row.data.via === "file");
  assert.deepEqual(told.map(row => [row.data.runId, row.data.version, row.data.during]), [[run, 2, true]]);
  assert.equal(app.signalsFor(id, from), null);
  fakes.release(); await app.wait(id);
});

test("the state carries the user's words whole and newest first, as many as a handoff's share for them; STATE.md the latest whole and where the rest are; board.md each entry's id", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared() }), app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  const long = "第一行\n" + "长".repeat(1000);
  await turn(app, id, "起头的话", "k1"); await turn(app, id, "中间的话", "k2"); await turn(app, id, long, "k3");
  app.writeBoard(id, "user", { kind: "constraint", text: "用 pnpm" });
  const context = new ContextFiles({ root: join(w.data, "context"), reader: w.store, name: () => null, board: other => app.taskBoard(other) });
  const all = context.state(id, undefined, false, "whole", 1_000_000)!;
  assert.ok(all.includes("- 第 3 轮：第一行\n  " + "长".repeat(1000)), "whole, its lines kept");
  assert.ok(all.indexOf("第 3 轮") < all.indexOf("第 2 轮") && all.indexOf("第 2 轮") < all.indexOf("第 1 轮"), "newest first");
  assert.doesNotMatch(all, /目标（/u, "the first words are among them: the goal is not said a second time");
  assert.match(all, /- 约束：用 pnpm（用户写的）/u);
  const least = context.state(id, undefined, false, "whole", 0)!;
  assert.match(least, /第 3 轮：第一行/u); assert.doesNotMatch(least, /中间的话/u); assert.match(least, /目标（这件事起头时用户的原话）：起头的话/u);
  assert.match(least, /更早的 2 轮里用户说的话没有放在这里，用 harnesshub 的 hub_turns/u);
  assert.doesNotMatch(context.state(id, undefined, false, "whole", "none")!, /用户在这段对话里说的话/u, "a packet carries them");
  await context.ensure(id);
  const place = context.place(id), state = readFileSync(join(place.dir, place.self, "STATE.md"), "utf8"), board = readFileSync(join(place.dir, "board.md"), "utf8");
  assert.ok(state.includes("第一行\n  " + "长".repeat(1000))); assert.match(state, /更早的 2 轮[^\n]*同一目录的 index\.md/u);
  assert.match(board, /- \[b1\] 用 pnpm \(the user\)/u);
});
