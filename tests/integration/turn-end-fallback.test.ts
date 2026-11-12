import assert from "node:assert/strict";
import test from "node:test";
import { SessionError } from "../../src/contracts/session.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { scriptedWorld } from "../fixtures/scripted-world.js";

// The last resort of a Turn's end (runtime.ts, `unrecorded`): the store refuses the end of a Turn twice — with its relay part and without it — for a rule of its rows, and the Turn is ended as what it is, unknown, and the
// conversation blocked. The end still does all it does apart from the relay: what was open in the Turn is closed as an unknown Turn's items are, the switch the Turn held up fails with it (and the input waiting for that
// switch), and the process the Turn was to keep is closed (the rows keep a process only for a Turn that completed) instead of being left in the Runtime's table with no row that says so.
// Only the Harness is made up; the store refuses by wrapping the real one.

class Gate<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}
/** The store, refusing the first `left` ends of the Run `state.runId` as the rules of its rows would (an INVALID_DATA the Runtime knows for a refusal of rows and not of the store). */
function refusing(state: { runId: string; left: number; refused: number }): (store: SqliteConversationStore) => SqliteConversationStore {
  return store => new Proxy(store, { get(target, property) {
    if (property === "transact") {
      return (id: Parameters<SqliteConversationStore["transact"]>[0], version: number, mutate: Parameters<SqliteConversationStore["transact"]>[2]) => target.transact(id, version, current => {
        const made = mutate(current);
        if (state.left > 0 && made.events.some(event => event.type === "run.ended" && event.data.runId === state.runId && event.data.unrecorded !== true)) {
          state.left--; state.refused++;
          throw new SessionError("INVALID_DATA", "a row the table's rules refuse (injected by the test)");
        }
        return made;
      });
    }
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } });
}

test("a Turn whose end the store refuses twice is ended unknown with its open items closed, the switch it held up failed with the input waiting for it, and its process not left kept; the Runtime goes on", { timeout: 30_000 }, async t => {
  const gate = new Gate<void>(), started = new Gate<void>(), state = { runId: "", left: 2, refused: 0 };
  const w = await scriptedWorld(t, turn => {
    if (turn > 1) return [{ type: "text", text: "fine" }];
    started.resolve(undefined);
    return { reply: false as const, hold: gate.promise, events: [{ type: "text", text: "working on it" }, { type: "tool", id: "t-open", title: "a long job", status: "in_progress", detail: { kind: "execute", input: "sleep 100" } }] };
  }, { wrap: refusing(state) });
  w.app.setRetention(w.id, true, "keep-it");
  state.runId = w.app.send(w.id, "start the job", "s1").runId;
  await started.promise;
  const switching = w.app.switch(w.id, { harnessId: "bravo" }, "to-bravo");
  const waiting = w.app.send(w.id, "after the switch", "s2");
  assert.equal(w.store.get(w.id).pendingSwitchId !== null, true, "a switch waits for the Turn");
  gate.resolve(undefined);
  // A blocked conversation is what `wait` ends by saying so: that is the state this Turn's end was to leave it in.
  await assert.rejects(w.app.wait(w.id), (error: unknown) => error instanceof SessionError && error.code === "SESSION_BLOCKED");
  assert.equal(state.refused, 2, "the end was refused with its relay part and without it");
  const after = w.store.get(w.id), first = after.runs.find(run => run.id === state.runId)!;
  assert.equal(first.status, "unknown", "the Turn is unknown, as a Turn whose end could not be recorded is");
  assert.equal(after.status, "blocked", "and the conversation is blocked until the user resumes it");
  // Everything that was open in the Turn is closed.
  const items = w.store.turnAt(w.id, first.ordinal, { inlineBytes: Infinity })!.items;
  assert.deepEqual(items.filter(item => item.status === "running" || item.status === "waiting").map(item => item.itemId), [], "no item of an ended Turn is left running or waiting");
  assert.equal(items.find(item => item.itemId === "tool:t-open")?.status, "unknown", "a call that never ended is told as what it was left as");
  // The switch the Turn held up fails with it, and so does the input waiting for it.
  assert.equal(after.pendingSwitchId, null, "no switch is left pending");
  assert.equal(after.switches.find(item => item.id === switching.switchId)?.status, "failed", "the switch failed");
  const second = after.runs.find(run => run.id === waiting.runId)!;
  assert.deepEqual([second.status, second.error?.code], ["failed", "SWITCH_NOT_EFFECTIVE"], "the input that waited for it was not dispatched");
  // The process the Turn was to keep is not kept: no row says so, and the Runtime's table does not hold it.
  assert.equal(after.retained, undefined, "the head records no kept process");
  assert.equal(first.retained, undefined);
  assert.equal(w.store.head(w.id).kept, false, "and the index that finds kept processes does not hold the conversation");
  assert.equal(w.app.keptProcess(w.id), null, "the Runtime does not hold a process that no row records");
  assert.deepEqual(verify(after, w.store), [], "the conversation breaks no rule of the whole-conversation check");
  // The Runtime goes on: another conversation is served.
  const other = await w.app.create(w.configuration, { harnessId: "alpha" }, "other");
  w.app.send(other.id, "hello", "o1"); await w.app.wait(other.id);
  assert.equal(w.app.read(other.id).runs[0]?.status, "completed", "another conversation runs to its end: " + JSON.stringify(w.app.read(other.id).runs[0]?.error));
});
