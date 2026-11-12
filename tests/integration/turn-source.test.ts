import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { sessionId } from "../../src/contracts/session.js";
import { turnSource } from "../../src/contexts/session/domain/turn-source.js";
import { snapshotTurns } from "../fixtures/old-shape.js";
import { appStore } from "../fixtures/runtime-store.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { temporary } from "../fixtures/store-helpers.js";

// The readers of the history take a conversation one Turn at a time (src/contexts/session/domain/turn-source.ts): a Turn is its Run with the words said in it, worked out from the
// rows the store keeps, read when it is asked for and once. For the conversations of every v13 fixture, converted by the store, each Turn is what the old whole shape told of that Run
// and its messages, and a Turn that was not asked for is not read.

test("every Turn of every converted fixture is what the old shape told of it, read when asked for and once", t => {
  const base = temporary(t);
  let turns = 0, legacy = 0;
  for (const name of V13_FIXTURES) {
    const data = join(base, name);
    writeV13Root(data, [loadV13Fixture(name)]);
    const store = appStore(data);
    try {
      for (const row of store.list({ limit: 500 }).rows) {
        const id = sessionId(row.id), old = store.snapshot(id);
        let reads = 0;
        const counting = { head: (value: typeof id) => store.head(value), turnAt: (...args: Parameters<typeof store.turnAt>) => { reads++; return store.turnAt(...args); } };
        const source = turnSource(counting, id);
        assert.equal(source.count, old.runs.length, id);
        assert.equal(reads, 0, "nothing is read before a Turn is asked for");
        const mine = snapshotTurns(old);
        for (let ordinal = 0; ordinal < source.count; ordinal++) {
          const turn = source.turn(ordinal)!, again = source.turn(ordinal);
          assert.equal(again, turn, "the same Turn is read once");
          assert.deepEqual(turn.run, old.runs[ordinal], name + " " + id + " Turn " + ordinal);
          assert.deepEqual([turn.user, ...(turn.assistant === undefined ? [] : [turn.assistant])], old.messages.filter(message => message.runId === old.runs[ordinal]!.id), name + " " + id + " Turn " + ordinal + ": its words");
          assert.deepEqual({ ...mine.turn(ordinal)!, legacyOrder: false }, { ...turn, legacyOrder: false }, "the snapshot's Turns are the same Turns");
          turns++; if (turn.legacyOrder) legacy++;
        }
        assert.equal(reads, source.count, "each Turn was read once, none other");
        assert.equal(source.turn(source.count), null); assert.equal(source.turn(-1), null); assert.equal(source.turn(1.5), null);
        assert.equal(mine.turn(source.count), null);
      }
    } finally { store.close(); }
  }
  assert.ok(turns >= 150, "the fixtures hold Turns: " + turns);
  assert.ok(legacy === turns, "every Turn the migration made keeps the fixed arrangement: " + legacy + " of " + turns);
});
