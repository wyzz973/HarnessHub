import assert from "node:assert/strict";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PAGE, type Conversation, type ConversationRun } from "../../src/contracts/conversation.js";
import { commandId, sessionId, type SessionId } from "../../src/contracts/session.js";
import { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { conversation, createCommand, event, replyItem, run, seedConverted, userItem } from "../fixtures/conversation-builder.js";
import { Scenario, created, newConversation, recoverUnfinished, temporary } from "../fixtures/store-helpers.js";

// The budgets of the store of conversations (ADR-057, the independent review's section 4, item 9): the cost of a commit does not follow the length of the history, a store
// opens in time that does not follow the number of conversations, a conversation of ten thousand Turns loads, and one with a reply of 20 MiB opens as a window. The numbers
// are measured on this machine with the other test files running beside this one, so the budgets are ratios between two sides measured together and generous bounds on the
// rest; a number is also put in the test's diagnostics.

const completed = { backend: { status: "completed" as const, reason: "done" }, cleanup: { closed: true as const, exitCode: 0, signal: null, protocolFailure: null } };
const median = (values: number[]): number => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
const fixed = (value: number): string => value.toFixed(value < 10 ? 2 : 0);

/** A conversation of `turns` finished Turns as a conversion writes them (a Run is terminal at its insert and its items follow, while the conversation is not yet v14). */
function history(name: string, turns: number): Conversation {
  const prefix = "run-" + name, id = sessionId("session-" + name);
  const runs: ConversationRun[] = Array.from({ length: turns }, (_, ordinal) => run(ordinal, "completed", [userItem(prefix + "-" + ordinal, "question " + ordinal), replyItem(prefix + "-" + ordinal, 2, 1, "completed", ["answer ", String(ordinal)])],
    { endedSeq: 100 + ordinal, ...completed }, prefix));
  const base = conversation(runs, { id });
  return { ...base, commands: [{ ...createCommand, id: commandId(createCommand.id + "-" + name), resultId: id }, ...base.commands.slice(1)] };
}
/** Writes the histories into the database of a data root the store made and closed, as conversions, and returns the root. */
function seeded(t: Parameters<typeof temporary>[0], histories: readonly Conversation[]): string {
  const data = join(temporary(t), "data");
  new SqliteConversationStore(data).close();
  const db = new DatabaseSync(join(data, "gateway.sqlite"), { timeout: 1000 });
  try {
    for (const past of histories) seedConverted({ db, root: data }, past, 1, 100 + past.runs.length + 10, "old question");
  } finally { db.close(); }
  return data;
}

test("the cost of a commit does not follow the length of the history: a window of text appended to a conversation of 10 Turns and to one of 5,000", t => {
  const data = seeded(t, [history("small", 10), history("large", 5000)]);
  const store = new SqliteConversationStore(data);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const ids = { small: sessionId("session-small"), large: sessionId("session-large") }, sides = { small: 10, large: 5000 };
  const scenario = { small: new Scenario(store, ids.small, "run-small", false), large: new Scenario(store, ids.large, "run-large", false) };
  const loading = { small: 0, large: 0 };
  for (const key of ["small", "large"] as const) {
    const started = performance.now(); store.get(ids[key]); loading[key] = performance.now() - started;
  }
  // The Turn in progress of each: accepted, started, and a segment of reply begun.
  const open = { small: scenario.small.open("now", "w"), large: scenario.large.open("now", "w") };
  const append = (id: SessionId, ordinal: number, text: string): number => {
    const started = performance.now();
    store.transact(id, store.get(id).version, current => {
      const runs = [...current.runs], entry = runs[ordinal]!;
      runs[ordinal] = { ...entry, items: entry.items!.map(held => held.seq === 2 ? { ...held, text: [...held.text, text] } : held) };
      return { next: { ...current, runs }, events: [event("run.output", { runId: entry.id })] };
    });
    return performance.now() - started;
  };
  const times: Record<"small" | "large", number[]> = { small: [], large: [] };
  // The two take turns, so that whatever else the machine does, it does to both.
  for (let window = 0; window < 450; window++) {
    for (const key of ["small", "large"] as const) {
      const took = append(ids[key], open[key].ordinal, "window " + window + " of text 窗口 ");
      if (window >= 50) times[key].push(took);
    }
  }
  const small = median(times.small), large = median(times.large), ratio = large / small;
  t.diagnostic(`a commit of one text window, median of 400: ${fixed(small)} ms with ${sides.small} Turns, ${fixed(large)} ms with ${sides.large} (x${ratio.toFixed(2)}); the conversation of 5,000 loaded in ${fixed(loading.large)} ms`);
  assert.equal(store.get(ids.small).runs[open.small.ordinal]!.items![1]!.textChunks, 451); assert.equal(store.get(ids.large).runs[open.large.ordinal]!.items![1]!.textChunks, 451);
  assert.ok(ratio < 2, `a commit costs ${ratio.toFixed(2)} times as much with 5,000 Turns as with 10`);
});

test("the cost of a commit that starts and ends Turns does not follow the history either: accepting, starting and ending a Turn on 10 Turns and on 5,000", t => {
  const data = seeded(t, [history("small", 10), history("large", 5000)]);
  const store = new SqliteConversationStore(data);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const scenarios = { small: new Scenario(store, sessionId("session-small"), "run-small", false), large: new Scenario(store, sessionId("session-large"), "run-large", false) };
  const times: Record<"small" | "large", number[]> = { small: [], large: [] };
  for (let round = 0; round < 60; round++) {
    for (const key of ["small", "large"] as const) {
      const started = performance.now();
      scenarios[key].turn("question " + round, "answer " + round);
      if (round >= 10) times[key].push(performance.now() - started);
    }
  }
  const small = median(times.small), large = median(times.large);
  t.diagnostic(`a whole Turn of four commits, median of 50: ${fixed(small)} ms with 10 Turns behind it, ${fixed(large)} ms with 5,000 (x${(large / small).toFixed(2)})`);
  assert.ok(large / small < 2, `a Turn costs ${(large / small).toFixed(2)} times as much with 5,000 Turns behind it as with 10`);
});

test("a store opens in time that does not follow the number of conversations: 20 and 2,000 conversations, one of them with work not finished", t => {
  const build = (count: number): string => {
    const data = join(temporary(t), "data"), store = new SqliteConversationStore(data);
    try {
      for (let index = 0; index < count; index++) {
        const made = created(store, newConversation(data, "c" + index));
        if (index % 400 === 0) new Scenario(store, made.conversation.id, "run-c" + index, false).turn("question", "answer");
      }
      new Scenario(store, created(store, newConversation(data, "unfinished")).conversation.id, "run-unfinished", false).open("go", "going");
    } finally { store.close(); }
    return data;
  };
  // Every start visits the one conversation that has work not finished (the recovery given leaves it as it is) and no other.
  let visited = 0;
  const few = build(20), many = build(2000), opening = (data: string): number => {
    const started = performance.now(), store = new SqliteConversationStore(data, { recover: () => { visited++; return null; } });
    const took = performance.now() - started;
    store.close();
    return took;
  };
  const first = { few: opening(few), many: opening(many) }, times: Record<"few" | "many", number[]> = { few: [], many: [] };
  assert.equal(visited, 2, "each of the first two starts visited one conversation");
  for (let round = 0; round < 7; round++) for (const key of ["few", "many"] as const) times[key].push(opening(key === "few" ? few : many));
  assert.equal(visited, 2 + 14);
  const few20 = median(times.few), many2000 = median(times.many);
  t.diagnostic(`opening a store: ${fixed(few20)} ms with 20 conversations, ${fixed(many2000)} ms with 2,000 (x${(many2000 / few20).toFixed(2)}), the first start ${fixed(first.few)} and ${fixed(first.many)} ms`);
  assert.ok(many2000 / few20 < 3, `opening costs ${(many2000 / few20).toFixed(2)} times as much with 2,000 conversations as with 20 (the conversations are not read)`);
});

test("a conversation of 10,000 Turns loads, is held in the memory the review estimated, commits at the cost of a small one, and opens as a window", t => {
  const data = seeded(t, [history("ten", 10_000)]);
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  collect();
  const store = new SqliteConversationStore(data), id = sessionId("session-ten");
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  collect();
  const before = process.memoryUsage(), started = performance.now();
  const loaded = store.get(id);
  const loadMs = performance.now() - started;
  collect();
  const held = process.memoryUsage().heapUsed - before.heapUsed;
  assert.equal(loaded.runs.length, 10_000);
  const windowStarted = performance.now(), window = store.window(id), windowMs = performance.now() - windowStarted;
  assert.equal(window.turns.length, PAGE.windowTurns); assert.ok(window.bytes < PAGE.windowBytes);
  const scenario = new Scenario(store, id, "run-ten", false), turnStarted = performance.now();
  scenario.turn("one more", "answer");
  const turnMs = performance.now() - turnStarted;
  t.diagnostic(`10,000 Turns: loaded in ${fixed(loadMs)} ms, ${(held / 1048576).toFixed(1)} MiB of heap held (${(held / 10_000).toFixed(0)} bytes a Turn); a window of ${PAGE.windowTurns} Turns in ${fixed(windowMs)} ms; a whole Turn of four commits in ${fixed(turnMs)} ms`);
  assert.ok(loadMs < 5000, "loaded in " + loadMs + " ms");
  assert.ok(held < 150 * 1048576, "the heap grew by " + held + " bytes");
  assert.ok(windowMs < 500);
  assert.equal(store.get(id).runs.length, 10_001);
});

test("a conversation with a reply of 20 MiB opens as a window that leaves the text out, reads it by range, and is held whole only by the recovery that must", t => {
  const data = join(temporary(t), "data"), store = new SqliteConversationStore(data);
  const made = created(store, newConversation(data, "huge")), id = made.conversation.id, scenario = new Scenario(store, id, "run-huge", false);
  scenario.turn("a question", "a short answer");
  const open = scenario.accept("write a lot"); scenario.start(open.ordinal);
  const first = scenario.say(open.ordinal, "start ");
  const piece = "窗口".repeat(10_922) + "ab", pieceBytes = Buffer.byteLength(piece);
  let bytes = Buffer.byteLength("start ");
  const writing = performance.now();
  while (bytes < 20 * 1024 * 1024) { scenario.append(open.ordinal, first.seq, piece); bytes += pieceBytes; }
  const writeMs = performance.now() - writing;
  const started = performance.now(), window = store.window(id), windowMs = performance.now() - started;
  const reply = window.turns.at(-1)!.items.find(entry => entry.seq === first.seq)!;
  assert.equal(reply.textOmitted, true); assert.equal(reply.textBytes, bytes); assert.deepEqual(reply.text, []);
  assert.ok(window.bytes < PAGE.windowBytes, "the window is " + window.bytes + " bytes");
  const rangeStarted = performance.now(), range = store.text(reply.runId, reply.seq, { from: bytes - 40, to: bytes }), rangeMs = performance.now() - rangeStarted;
  assert.equal(range.total, bytes); assert.ok(range.text.endsWith("ab"));
  store.close();
  // A start that must recover the Turn holds it whole, as it must; the time and the heap are put on record.
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  collect();
  const heap = process.memoryUsage().heapUsed, recovering = performance.now();
  const reopened = new SqliteConversationStore(data, { recover: recoverUnfinished });
  const recoverMs = performance.now() - recovering;
  collect();
  const held = process.memoryUsage().heapUsed - heap;
  try { assert.equal(reopened.get(id).runs[1]!.status, "unknown"); assert.equal(reopened.window(id).turns.at(-1)!.items.find(entry => entry.seq === first.seq)!.textBytes, bytes); } finally { reopened.close(); }
  t.diagnostic(`a reply of ${(bytes / 1048576).toFixed(1)} MiB written in ${fixed(writeMs)} ms (${Math.round(bytes / pieceBytes)} commits); the window in ${fixed(windowMs)} ms and ${window.bytes} bytes; its last 40 bytes in ${fixed(rangeMs)} ms; the recovery that held it whole: ${fixed(recoverMs)} ms, ${(held / 1048576).toFixed(1)} MiB of heap`);
  assert.ok(windowMs < 500 && rangeMs < 200);
});
