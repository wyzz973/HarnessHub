import assert from "node:assert/strict";
import test from "node:test";
import type { EventDraft } from "../../src/contracts/session.js";
import { SessionError, type SessionId } from "../../src/contracts/session.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { scriptedWorld, type ScriptedWorld } from "../fixtures/scripted-world.js";
import { oldShape } from "../fixtures/old-shape.js";

// One judgment of what a failure means for the Runtime (runtime.ts `stalls`): only a failure that says the store cannot be trusted (storage, ownership, version) stalls it; a rule of the rows refusing one
// write (INVALID_DATA, INVALID_TRANSITION) ends only the request or the Turn it belonged to. One case for each place that used to stall the Runtime for any failure: the worker's serving of a switch,
// the Turn's wait for a slot, its wait for the user, the expiry of its budget, the close of a kept process, the log of an abandoned request, the end of a Turn, and the reading of a conversation. In each, the
// store refuses what it is told to (by wrapping the real one), and the Runtime must go on to serve another conversation.

class Gate<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}
interface Refusals { refused: number; events: string[] }
/** The store, refusing with a rule of the rows (never a storage failure) the first `times` commits whose events `match`, and the first `reads` readings (`get`) of the conversation `unreadable`. */
function refusing(counter: Refusals, match: (events: readonly EventDraft[]) => boolean, times = 1, unreadable: { id: () => SessionId | null; reads: number } = { id: () => null, reads: 0 }): (store: SqliteConversationStore) => SqliteConversationStore {
  let unread = unreadable.reads;
  return store => new Proxy(store, { get(target, property) {
    if (property === "transact") {
      return (id: Parameters<SqliteConversationStore["transact"]>[0], version: number, mutate: Parameters<SqliteConversationStore["transact"]>[2]) => target.transact(id, version, current => {
        const made = mutate(current);
        if (counter.refused < times && match(made.events)) {
          counter.refused++; counter.events.push(made.events.map(event => event.type).join(","));
          throw new SessionError("INVALID_DATA", "a row the table's rules refuse (injected by the test)");
        }
        return made;
      });
    }
    if (property === "get") return (id: SessionId) => { if (unread > 0 && id === unreadable.id()) { unread--; counter.refused++; throw new SessionError("INVALID_DATA", "a row that cannot be read (injected by the test)"); } return target.get(id); };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } });
}
const has = (...types: string[]) => (events: readonly EventDraft[]): boolean => events.some(event => types.includes(event.type));
const ending = (runId: () => string) => (events: readonly EventDraft[]): boolean => events.some(event => event.type === "run.ended" && event.data.runId === runId());

/** Another conversation of the same Runtime is served to the end of a Turn: the Runtime was not stalled. */
async function serves(w: ScriptedWorld, name: string): Promise<void> {
  assert.equal(oldShape(w.app, w.id) !== undefined, true);
  const other = await w.app.create(w.configuration, { harnessId: "alpha" }, "other-" + name);
  w.app.send(other.id, "are you still there?", "other-" + name + "-1"); await w.app.wait(other.id);
  assert.equal(oldShape(w.app, other.id).runs[0]?.status, "completed", name + ": another conversation runs to its end");
}
const quiet = () => [{ type: "text", text: "fine" }] as const;

test("a switch the store's rows refuse fails that switch and the inputs waiting for it, and the Runtime goes on (the worker's serving)", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] };
  const w = await scriptedWorld(t, quiet, { wrap: refusing(counter, has("switch.effective")) });
  const switching = w.app.switch(w.id, { harnessId: "bravo" }, "to-bravo");
  await w.app.wait(w.id);
  assert.equal(counter.refused, 1, "the store refused the switch taking effect");
  const after = w.store.get(w.id);
  assert.equal(after.switches.find(item => item.id === switching.switchId)?.status, "failed", "that switch failed");
  assert.equal(after.switches.find(item => item.id === switching.switchId)?.error?.code, "INVALID_DATA", "with the reason it was refused for");
  assert.equal(after.pendingSwitchId, null); assert.equal(after.status, "open", "and the conversation is open, as before the switch");
  await serves(w, "switch");
});

test("a conversation that cannot be read once does not stall the Runtime: the read fails, another conversation is served, and the same one is read again", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] };
  let target: SessionId | null = null;
  const w = await scriptedWorld(t, quiet, { wrap: refusing(counter, () => false, 1, { id: () => target, reads: 1 }) });
  target = w.id;
  // The Runtime's own read of a conversation (the one behind the relay's attention): it is the read that fails once, and it must not stall the Runtime.
  assert.throws(() => w.app.relayAttention(w.id), (error: unknown) => error instanceof SessionError && error.code === "INVALID_DATA");
  assert.equal(counter.refused, 1);
  await serves(w, "read");
  assert.doesNotThrow(() => w.app.relayAttention(w.id), "the conversation that failed to read once reads again");
  assert.equal(oldShape(w.app, w.id).id, w.id);
});

test("the close of a kept process that the rows refuse to record still closes it, and the Runtime goes on", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] };
  const w = await scriptedWorld(t, quiet, { wrap: refusing(counter, has("native.process_closed")) });
  w.app.setRetention(w.id, true, "keep");
  await w.send("first");
  assert.notEqual(w.app.keptProcess(w.id), null, "the Turn handed its process over");
  await w.app.endKept(w.id, "end-kept");
  assert.equal(counter.refused, 1, "the store refused the record of the close");
  assert.equal(w.app.keptProcess(w.id), null, "the process is closed all the same");
  await serves(w, "kept");
});

test("the log of an abandoned request that the rows refuse does not stop the Turn's end: the Turn ends and the Runtime goes on", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] };
  const w = await scriptedWorld(t, () => ({ reply: false as const, events: [{ type: "text", text: "may I?" }, { type: "permission_requested", id: "ask", title: "May I?", options: [{ id: "yes", name: "Yes" }] }] }), { wrap: refusing(counter, has("permission.closed")) });
  const run = w.app.send(w.id, "do it", "s1").runId;
  await w.app.wait(w.id).catch(() => {});
  assert.equal(counter.refused, 1, "the store refused the log of the request the Turn left open");
  const ended = oldShape(w.app, w.id).runs.find(item => item.id === run)!;
  assert.ok(["completed", "cancelled", "unknown", "failed"].includes(ended.status), "the Turn ended: " + ended.status);
  await serves(w, "abandoned");
});

test("a Turn whose end the rows refuse in every form ends only that Turn: the log says so, the Runtime serves another conversation", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] }, state = { runId: "" };
  const w = await scriptedWorld(t, quiet, { wrap: refusing(counter, ending(() => state.runId), 100) });
  state.runId = w.app.send(w.id, "never ends", "s1").runId;
  await w.app.wait(w.id).catch(() => {});
  assert.ok(counter.refused >= 3, "the end was refused with its relay part, without it, and in the last resort: " + counter.refused);
  assert.ok(w.store.events(w.id, 0, 200).some(event => event.type === "run.end_unrecorded" && event.data.runId === state.runId), "the log says the end could not be recorded");
  await serves(w, "outermost");
});

test("a Turn's wait for a slot that the rows refuse to log the end of still goes on: the next conversation runs when the slot is free, and the Runtime is not stalled", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] }, gate = new Gate(), started = new Gate();
  const w = await scriptedWorld(t, turn => {
    if (turn === 1) { started.resolve(); return { reply: false as const, hold: gate.promise, events: [{ type: "text", text: "busy" }] }; }
    return quiet();
  }, { runtime: { maxParallel: 1 }, wrap: refusing(counter, events => events.some(event => event.type === "run.waiting_ended" && event.data.kind === "slot")) });
  w.app.send(w.id, "take the slot", "s1"); await started.promise;
  const other = await w.app.create(w.configuration, { harnessId: "alpha" }, "waiter");
  w.app.send(other.id, "wait for the slot", "w1");
  assert.notEqual(w.app.slotWait(other.id), null, "the second conversation waits for the slot");
  gate.resolve(); await w.app.wait(w.id); await w.app.wait(other.id);
  assert.equal(counter.refused, 1, "the store refused the log of the wait's end");
  assert.equal(oldShape(w.app, other.id).runs[0]?.status, "completed", "the conversation that waited ran when the slot was free");
});

test("a Turn's wait for the user that the rows refuse to log the end of still goes on: the Turn completes and the Runtime is not stalled", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] }, gate = new Gate(), asked = new Gate();
  const w = await scriptedWorld(t, turn => {
    if (turn > 1) return quiet();
    asked.resolve();
    return { reply: false as const, hold: gate.promise, events: [{ type: "text", text: "may I?" }, { type: "permission_requested", id: "ask", title: "May I?", options: [{ id: "yes", name: "Yes" }] }] };
  }, { wrap: refusing(counter, events => events.some(event => event.type === "run.waiting_ended" && event.data.kind === "user")) });
  const run = w.app.send(w.id, "ask me", "s1").runId; await asked.promise;
  const request = w.app.permissionRequests(w.id)[0];
  assert.ok(request !== undefined, "a request waits for the user");
  await w.app.decidePermission(w.id, request.id, "yes", "decide-1");
  gate.resolve(); await w.app.wait(w.id);
  assert.equal(counter.refused, 1, "the store refused the log of the wait's end");
  assert.equal(oldShape(w.app, w.id).runs.find(item => item.id === run)?.status, "completed", "the Turn went on and completed");
  await serves(w, "wait");
});

test("a Turn whose budget ran out but whose expiry the rows refuse to log is still stopped by it, and the Runtime is not stalled", { timeout: 30_000 }, async t => {
  const counter: Refusals = { refused: 0, events: [] }, gate = new Gate(), started = new Gate();
  const w = await scriptedWorld(t, turn => {
    if (turn > 1) return quiet();
    started.resolve();
    return { reply: false as const, hold: gate.promise, events: [{ type: "text", text: "slow" }] };
  }, { runtime: { executionBudgetMs: 60 }, wrap: refusing(counter, has("run.budget_expired")) });
  const run = w.app.send(w.id, "take long", "s1").runId; await started.promise;
  while (counter.refused === 0) await new Promise(resolve => setTimeout(resolve, 10));
  gate.resolve(); await w.app.wait(w.id);
  const ended = oldShape(w.app, w.id).runs.find(item => item.id === run)!;
  assert.equal(ended.status, "cancelled"); assert.equal(ended.error?.code, "RUN_TIMEOUT", "the budget stopped the Turn although its expiry was not logged");
  await serves(w, "expire");
});
