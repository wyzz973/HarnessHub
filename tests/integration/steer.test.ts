import assert from "node:assert/strict";
import test from "node:test";
import type { HeldItem } from "../../src/contracts/conversation.js";
import { SessionError, type SessionId } from "../../src/contracts/session.js";
import type { FileConversationStore } from "../../src/infrastructure/session/file-store.js";
import { turnSource } from "../../src/contexts/session/domain/turn-source.js";
import { Fakes, declared, events, world } from "../fixtures/relay-fakes.js";
import { oldShape } from "../fixtures/old-shape.js";

/** The items of a conversation's Turn as the store keeps them, in place order. */
function itemsOf(store: FileConversationStore, id: SessionId, ordinal: number): readonly HeldItem[] {
  return [...store.turnAt(id, ordinal, { inlineBytes: Infinity })!.items].sort((left, right) => left.seq - right.seq);
}
const steers = (items: readonly HeldItem[]) => items.filter(item => item.itemId.startsWith("steer:"));
const refusedWith = (code: string) => (error: unknown) => error instanceof SessionError && error.code === code;

test("words given to a Turn in progress go into it as a user message of their own, written before the Harness is given them, once per key", async t => {
  const w = world(t, "steer-"), fakes = new Fakes({ alpha: declared() });
  fakes.steerable.add("alpha");
  const app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  fakes.script = () => ({ result: "hold" });
  app.send(id, "work, then answer A", "k1"); await fakes.reached("alpha", 1);
  // Written before the Harness is given them: the item is there, pending, when the Harness is asked.
  fakes.steerAnswer = () => { const pending = steers(itemsOf(w.store, id, 0)); assert.deepEqual(pending.map(item => item.status), ["pending"]); return "taken"; };
  const receipt = await app.steer(id, "answer B instead", "s1");
  assert.deepEqual([receipt.outcome, receipt.replayed, receipt.runId], ["taken", false, oldShape(app, id).runs[0]!.id]);
  // The same key answers as the first request did, and gives the Harness nothing more; another request under it is a conflict.
  const again = await app.steer(id, "answer B instead", "s1");
  assert.deepEqual([again.outcome, again.replayed, again.messageId], ["taken", true, receipt.messageId]);
  await assert.rejects(app.steer(id, "something else", "s1"), refusedWith("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(fakes.steered.map(row => row.text), ["answer B instead"]);
  fakes.release(); await app.wait(id);

  const items = itemsOf(w.store, id, 0), steer = steers(items);
  assert.equal(oldShape(app, id).runs[0]!.status, "completed");
  assert.equal(steer.length, 1);
  assert.deepEqual([steer[0]!.type, steer[0]!.status, steer[0]!.text.join(""), (steer[0]!.fields as { steered?: true }).steered, (steer[0]!.fields as { messageId?: string }).messageId],
    ["user_message", "completed", "answer B instead", true, receipt.messageId]);
  // It stands where the Harness took it: after what the turn had said, before what it said after.
  assert.deepEqual(items.map(item => item.itemId), ["user", "text:1", "steer:1", "text:2"]);
  assert.equal(items.find(item => item.itemId === "text:2")!.text.join(""), "took: answer B instead");
  // The native session holds the Turn's input and then the words.
  assert.deepEqual(fakes.history.get(fakes.to("alpha")[0]!.session), ["work, then answer A", "answer B instead"]);
  assert.ok(events(w.store, id).some(row => row.type === "message.steered" && row.data.messageId === receipt.messageId && row.data.text === "answer B instead"));
  // The Turn's readers (a handoff, the record, the export) read them as the user's words of the Turn, after its input.
  const source = turnSource(w.store, id);
  assert.equal(source.turn(0)!.user.text, "work, then answer A\n\nanswer B instead");
  assert.equal(turnSource(w.store, id).outline(0)!.user.text(), "work, then answer A\n\nanswer B instead");
  // Once the Turn is over there is nothing to give words to; the first request still answers as it did.
  await assert.rejects(app.steer(id, "too late", "s2"), refusedWith("STEER_NO_ACTIVE_TURN"));
  assert.equal((await app.steer(id, "answer B instead", "s1")).outcome, "taken");
});

test("words the Harness does not take, or that its connection cannot take, are refused and left to the page; a request that fails leaves them unknown", async t => {
  const w = world(t, "steer-"), fakes = new Fakes({ alpha: declared(), beta: declared() });
  fakes.steerable.add("alpha");
  const app = w.runtime(fakes);
  fakes.script = () => ({ result: "hold" });
  // A Harness that takes no words mid-turn: refused, and nothing written.
  const plain = (await app.create(w.configuration, { harnessId: "beta" }, "create-beta")).id;
  app.send(plain, "work", "b1"); await fakes.reached("beta", 1);
  await assert.rejects(app.steer(plain, "steer me", "bs1"), refusedWith("STEER_UNSUPPORTED"));
  assert.equal(steers(itemsOf(w.store, plain, 0)).length, 0);
  fakes.release(); await app.wait(plain);

  const id = (await app.create(w.configuration, { harnessId: "alpha" }, "create-alpha")).id;
  app.send(id, "work", "a1"); await fakes.reached("alpha", 1);
  // The Harness took nothing (its turn had just ended): STEER_REFUSED, and the item says so; a repeat of the key says the same.
  fakes.steerAnswer = () => "not_taken";
  await assert.rejects(app.steer(id, "too late for it", "as1"), refusedWith("STEER_REFUSED"));
  await assert.rejects(app.steer(id, "too late for it", "as1"), refusedWith("STEER_REFUSED"));
  // The request failed: the words may have reached it, so they are unknown, and never refused for the page to send again.
  fakes.steerAnswer = () => new Error("the connection ended");
  assert.equal((await app.steer(id, "maybe heard", "as2")).outcome, "unknown");
  fakes.release(); await app.wait(id);
  assert.deepEqual(steers(itemsOf(w.store, id, 0)).map(item => [item.text.join(""), item.status]), [["too late for it", "declined"], ["maybe heard", "unknown"]]);
  assert.deepEqual(fakes.steered, []);
  // Words the Harness refused are not the Turn's; words it may have heard are.
  assert.equal(turnSource(w.store, id).turn(0)!.user.text, "work\n\nmaybe heard");
});
