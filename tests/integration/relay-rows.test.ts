import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { sessionId } from "../../src/contracts/session.js";
import type { ConversationReader } from "../../src/contracts/conversation.js";
import { needRuns } from "../../src/contexts/session/application/relay-coordinator.js";
import { buildPublicContext, publicSources } from "../../src/contexts/session/domain/context.js";
import { rowsHistory } from "../../src/contexts/session/domain/relay/history.js";
import { snapshotHistory } from "../fixtures/old-shape.js";
import { appStore } from "../fixtures/runtime-store.js";
import { scriptedWorld } from "../fixtures/scripted-world.js";
import { temporary } from "../fixtures/store-helpers.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";

// The relay's renderer fed from rows (src/contexts/session/domain/relay/history.ts): the Runs' light rows and, of the Turns a packet owes, their words read a Turn at a time — the same packet,
// byte for byte, as the one made from the conversation's old whole shape; and a packet that owes three Turns of twelve reads three (and the one that asks), not the conversation.

const stamp = new Date("2026-11-13T00:00:00.000Z");
const names = (harnessId: string): string | null => ({ alpha: "Alpha Harness", bravo: "Bravo Harness", claude: "Claude Code", codex: "Codex" })[harnessId] ?? null;

for (const name of V13_FIXTURES) {
  test(`${name}: the packet made from the rows is the packet made from the old whole shape, for the last input of each conversation, with the history it started from when it has one`, { timeout: 60_000 }, t => {
    const fixture = loadV13Fixture(name), data = join(temporary(t), "data");
    writeV13Root(data, [fixture]);
    const store = appStore(data, { now: () => stamp });
    try {
      for (const row of fixture.sessions) {
        const id = sessionId(row.id), snapshot = store.snapshot(id), conversation = store.get(id);
        if (snapshot.runs.length === 0) continue;
        const rows = rowsHistory(conversation, store), old = snapshotHistory(snapshot), at = snapshot.runs.length - 1;
        const currentFromRows = rows.turn(at)!.run, currentFromOld = old.turn(at)!.run;
        assert.deepEqual(publicSources(rows, currentFromRows), publicSources(old, currentFromOld), name + " " + row.id + ": the sources");
        for (const origin of rows.origin === undefined ? [false] : [false, true]) {
          const options = { origin, names, hubTools: origin };
          const fromRows = buildPublicContext(rows, currentFromRows, undefined, options), fromOld = buildPublicContext(old, currentFromOld, undefined, options);
          assert.deepEqual(fromRows, fromOld, name + " " + row.id + (origin ? " with its starting history" : ""));
        }
        const facts = conversation.runs.filter(run => run.status === "completed").map(run => ({ runId: run.id, seq: run.endedSeq ?? conversation.lastSeq, executedOn: null }));
        assert.deepEqual(needRuns(rows, currentFromRows, { facts }), needRuns(old, currentFromOld, { facts }), name + " " + row.id + ": the Runs owed");
      }
    } finally { store.close(); }
  });
}

test("a packet that owes three Turns of twelve reads those three and the Turn that asks, once each: not the conversation", { timeout: 30_000 }, async t => {
  const w = await scriptedWorld(t, turn => [{ type: "text", text: "the answer to question " + turn }]);
  for (let turn = 1; turn <= 12; turn++) await w.send("question " + turn);
  const conversation = w.store.get(w.id), read: number[] = [];
  const spy: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory"> = {
    head: id => w.store.head(id), runOrdinal: (id, runId) => w.store.runOrdinal(id, runId), originHistory: id => w.store.originHistory(id),
    turnAt: (id, ordinal, options) => { read.push(ordinal); return w.store.turnAt(id, ordinal, options); },
  };
  const history = rowsHistory(conversation, spy), current = history.turn(11)!.run, owed = conversation.runs.slice(8, 11).map(run => run.id);
  const context = buildPublicContext(history, current, owed, { names });
  assert.deepEqual([...read].sort((a, b) => a - b), [8, 9, 10, 11], "the three Turns it owes and the one that asks, each once");
  for (const turn of [9, 10, 11]) assert.ok(context.text.includes("question " + turn) && context.text.includes("the answer to question " + turn), "turn " + turn + " is in the packet");
  assert.equal(context.text.includes("question 8 "), false, "and no other");
  assert.deepEqual(context.sourceRunIds, owed);
});
